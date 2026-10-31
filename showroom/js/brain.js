// Gemini Live: one session for typed chat and the microphone, always answering in the same voice.
// Typed text and spoken audio go into the same conversation; the robot always replies with audio + transcript.

const WORKLET = `
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1600); this.n = 0; this.sum = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i])); this.sum += v * v;
      this.buf[this.n++] = v * 32767;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.slice(0), rms: Math.sqrt(this.sum / this.n) });
        this.n = 0; this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor("mic", Mic);`;

function b64(buf) { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

export class Live {
  // `endpoint` returns the WebSocket URL for a new session (a key URL locally, or one built from a short-lived token)
  constructor({ endpoint, model, voice, system, tools, onTool, on }) {
    Object.assign(this, { endpoint, model, voice, system, tools, onTool, on });
    this.ws = null; this.state = "closed"; this.sources = []; this.nextT = 0; this.turnOpen = false;
    this.quietWaiters = []; this.mic = null; this.history = []; this.said = ""; this.heard = "";
  }
  get ready() { return this.state === "ready"; }

  connect() {
    if (this.state === "ready" || this.state === "opening") return this.opening;
    this.state = "opening"; this.on.state && this.on.state("connecting");
    this.opening = this.endpoint().then(url => new Promise(resolve => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const recap = this.history.slice(-10).map(h => `${h.who}: ${h.text}`).join("\n");
      ws.onopen = () => ws.send(JSON.stringify({ setup: {
        model: "models/" + this.model,
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } } },
        systemInstruction: { parts: [{ text: this.system() + (recap ? `\n\nCONVERSATION SO FAR (continue it, don't restart):\n${recap}` : "") }] },
        tools: [{ functionDeclarations: this.tools }],
        realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW", endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                                                             silenceDurationMs: 600, prefixPaddingMs: 200 } },
        inputAudioTranscription: {}, outputAudioTranscription: {},
        contextWindowCompression: { triggerTokens: 16000, slidingWindow: { targetTokens: 8000 } },
      } }));
      ws.onmessage = async ev => {
        if (ws !== this.ws) return;
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : await ev.data.text());
        if (m.setupComplete) { this.state = "ready"; this.on.state && this.on.state("live"); resolve(true); return; }
        this.handle(m);
      };
      ws.onclose = ev => {
        if (ws !== this.ws) return;
        this.ws = null; const was = this.state; this.state = "closed";
        this.on.state && this.on.state("closed", ev.reason || (was === "opening" ? "could not connect" : ""));
        this.stopMic(); resolve(false); this.endTurn();
      };
    }), e => {
      this.state = "closed"; this.on.state && this.on.state("closed", "could not connect: " + (e.message || e)); return false;
    });
    return this.opening;
  }

  close() { if (this.ws) { const w = this.ws; this.ws = null; w.close(); } this.state = "closed"; this.stopMic(); this.stopPlayback(); }

  send(o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; }

  async text(t, who = "Guest") {
    if (!this.ready && !(await this.connect())) return false;
    this.history.push({ who, text: t });
    this.stopPlayback(); this.replyStarted = false;
    return this.send({ realtimeInput: { text: t } });
  }

  handle(m) {
    const sc = m.serverContent;
    if (sc) {
      if (sc.inputTranscription && sc.inputTranscription.text) { this.heard += sc.inputTranscription.text; this.on.heard && this.on.heard(this.heard); }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        if (this.heard.trim()) { this.history.push({ who: "Guest", text: this.heard.trim() }); this.on.heardDone && this.on.heardDone(this.heard.trim()); this.heard = ""; }
        this.markReply(); this.said += sc.outputTranscription.text; this.on.said && this.on.said(this.said);
      }
      for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) if (p.inlineData && p.inlineData.data) { this.turnOpen = true; this.markReply(); this.play(p.inlineData.data); }
      if (sc.interrupted) { this.stopPlayback(); this.endTurn(); }
      if (sc.turnComplete) this.endTurn();
    }
    if (m.toolCall) this.tool(m.toolCall);
    if (m.goAway) { /* the server will close soon; the next message reconnects with a recap */ }
  }

  endTurn() {
    if (this.heard.trim()) { this.history.push({ who: "Guest", text: this.heard.trim() }); this.on.heardDone && this.on.heardDone(this.heard.trim()); }
    if (this.said.trim()) { this.history.push({ who: "Robot", text: this.said.trim() }); this.on.saidDone && this.on.saidDone(this.said.trim()); }
    this.said = ""; this.heard = ""; this.turnOpen = false;
    this.checkQuiet();
  }

  async tool(tc) {
    const out = [];
    for (const c of tc.functionCalls || []) {
      let response;
      try { response = await this.onTool(c.name, c.args || {}); } catch (e) { response = { ok: false, error: String(e.message || e) }; }
      out.push({ id: c.id, name: c.name, response });
    }
    this.send({ toolResponse: { functionResponses: out } });
  }

  // ---- audio out (24 kHz PCM16) ----
  ctx() { if (!this.ac) this.ac = new AudioContext(); if (this.ac.state === "suspended") this.ac.resume(); return this.ac; }
  play(data) {
    const ctx = this.ctx(), bin = atob(data), n = bin.length >> 1, f = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; f[i] = v / 32768; }
    const buf = ctx.createBuffer(1, n, 24000); buf.copyToChannel(f, 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.06, this.nextT); src.start(at); this.nextT = at + buf.duration;
    this.sources.push(src);
    if (this.sources.length === 1) this.on.speaking && this.on.speaking(true);
    src.onended = () => {
      this.sources = this.sources.filter(s => s !== src);
      if (!this.sources.length) { this.on.speaking && this.on.speaking(false); this.checkQuiet(); }
    };
  }
  playing() { return this.sources.length > 0; }
  stopPlayback() {
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch (_) {} }
    const was = this.sources.length; this.sources = []; this.nextT = 0;
    if (was) this.on.speaking && this.on.speaking(false);
  }
  markReply() { if (this.replyStarted) return; this.replyStarted = true; const w = this.replyWaiters || []; this.replyWaiters = []; w.forEach(f => f()); }
  // resolves once the reply to the last message has started (or after `ms`), then when it has finished playing
  async answered(ms = 9000) {
    if (!this.replyStarted) await new Promise(r => { (this.replyWaiters = this.replyWaiters || []).push(r); setTimeout(r, ms); });
    await this.quiet();
  }
  // resolves when the robot has finished its turn and stopped talking
  quiet() { return new Promise(r => { this.quietWaiters.push(r); this.checkQuiet(); }); }
  checkQuiet() {
    if (this.turnOpen || this.playing()) return;
    const w = this.quietWaiters; this.quietWaiters = []; setTimeout(() => w.forEach(f => f()), 250);
  }

  // ---- mic in (16 kHz PCM16) ----
  async startMic() {
    if (this.mic) return true;
    if (!this.ready && !(await this.connect())) return false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ac = new AudioContext({ sampleRate: 16000 });
    await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ac, "mic"), srcNode = ac.createMediaStreamSource(stream);
    srcNode.connect(node);
    const silent = new Int16Array(1600);
    node.port.onmessage = e => {
      const { pcm, rms } = e.data;
      this.on.level && this.on.level(rms);
      // while the robot talks, only a clearly louder voice gets through (keeps the speakers from interrupting it)
      const pass = !this.playing() || rms > 0.06;
      this.send({ realtimeInput: { audio: { data: b64((pass ? pcm : silent).buffer), mimeType: "audio/pcm;rate=16000" } } });
    };
    this.mic = { stream, ac, node };
    this.ctx();
    return true;
  }
  stopMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach(t => t.stop()); this.mic.ac.close(); this.mic = null;
    this.send({ realtimeInput: { audioStreamEnd: true } });
    this.on.level && this.on.level(0);
  }
}

// Offline stand-in when there is no key or the connection fails: keyword routing and a fixed browser voice.
export class LocalVoice {
  constructor() { this.voice = null; this.speaking = false; }
  pick() {
    if (this.voice) return this.voice;
    const vs = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang));
    this.voice = vs.find(v => /Guy|Andrew|Christopher|Daniel/i.test(v.name)) || vs[0] || null;
    return this.voice;
  }
  say(text, on) {
    return new Promise(res => {
      const u = new SpeechSynthesisUtterance(text); const v = this.pick(); if (v) u.voice = v;
      u.rate = 1.03; u.onstart = () => on && on(true);
      u.onend = u.onerror = () => { on && on(false); res(); };
      speechSynthesis.speak(u);
    });
  }
  stop() { speechSynthesis.cancel(); }
}
