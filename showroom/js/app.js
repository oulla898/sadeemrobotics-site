import { CARS, byId } from "./cars.js";
import { createWorld } from "./world.js";
import { Live, LocalVoice } from "./brain.js";

// key: a Gemini key (local use). tokenUrl: a server that checks the password and hands out short-lived tokens (website).
const CFG = Object.assign({ key: "", tokenUrl: "", model: "gemini-3.8-live", voice: "Achird", robotName: "Tamra" }, window.SIM_CONFIG || {});
if (new URLSearchParams(location.search).has("offline")) CFG.key = CFG.tokenUrl = "";      // backup for a pitch without internet: ?offline
const LIVE_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.";
const PASS_KEY = "sadeem-showroom-pass";
const storedPass = () => { try { return sessionStorage.getItem(PASS_KEY) || ""; } catch (_) { return ""; } };
async function fetchToken(password) {
  const r = await fetch(CFG.tokenUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  if (r.status === 401) throw new Error("wrong password");
  if (!r.ok) throw new Error("token server " + r.status);
  return r.json();
}
async function endpoint() {
  if (CFG.key) return `${LIVE_WS}v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(CFG.key)}`;
  const t = await fetchToken(storedPass());      // one token per session; reconnects fetch a fresh one
  return `${LIVE_WS}v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(t.token)}`;
}
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const carIds = CARS.map(c => c.id);

// ---------------------------------------------------------------- prompt + tools
function systemPrompt() {
  const cat = CARS.map(c => ({ id: c.id, name: c.name, type: c.type, seats: c.seats, price: c.price, tagline: c.tagline,
    specs: Object.fromEntries(c.specs), selling_points: c.points, best_for: c.for }));
  return `You are ${CFG.robotName}, a robot host in a car showroom, built by Sadeem Robotics. You move on your own, you have a screen on your head, and a guest is standing with you.
You talk like the showroom's best salesperson: warm, quick, confident, human. Short spoken sentences. No lists, no markdown, no emojis.
Never say canned assistant lines like "How can I help?" or "How may I assist you?". Lead with what matters to the guest.
Speak English by default. Switch to Arabic only when the guest writes or speaks Arabic, then use natural Omani/Gulf Arabic. Messages in brackets are not the guest: keep the language the guest last used.

HOW YOU WORK
- When the guest wants to see a car (by name, or by need like "a 7-seater", "something electric", "the fastest one"), pick the best match and call walk_to_car IMMEDIATELY, before you speak. Then talk while you walk: one or two sentences on why this car fits them. Don't dump specs while walking.
- You will get an [ARRIVED] message when you reach the car. Then present it: point at one or two things they can see, give one or two numbers that matter to them, and end with one short question (who drives, how many kids, what they drive now). About 20 seconds of speech.
- When they ask for numbers or details at the car, call show_on_screen with view "facts" and answer.
- If a better car fits after you learn more, say so and offer to walk them there.
- If they ask for a plan or routine (for example "build a plan to welcome guests when they arrive, guide them to a car and explain it"), call build_plan with clear steps, then describe it in one or two sentences and say they can run it. If they say run it / start it / test it, call run_plan.
- Price questions: give the "from" price and offer a consultant for offers and finance (call call_consultant if they want one).
- [EVENT] and [PLAN STEP] messages come from your own sensors and routine, not from the guest. Follow them and speak to the guest, never mention the brackets.
- Never invent specs that aren't below. If unsure, say a consultant will confirm.
- The showroom belongs to the dealer; Sadeem Robotics only built you. Don't name the showroom when you welcome people.
- About yourself only if asked: you are ${CFG.robotName}, made by Sadeem Robotics in Oman, you navigate with LiDAR and maps. Never mention Google or Gemini.

THE SHOWROOM (demo lineup, fictional models)
${JSON.stringify(cat)}`;
}

const TOOLS = [
  { name: "walk_to_car", description: "Walk the guest to a car on the showroom floor. The guest walks beside you. Call this before talking about a car they want to see.",
    parameters: { type: "OBJECT", properties: { car_id: { type: "STRING", enum: carIds }, reason: { type: "STRING", description: "Why this car fits, a few words" } }, required: ["car_id"] } },
  { name: "show_on_screen", description: "Change what your head screen shows.",
    parameters: { type: "OBJECT", properties: { view: { type: "STRING", enum: ["car", "facts", "grid", "eyes"] }, car_id: { type: "STRING", enum: carIds } }, required: ["view"] } },
  { name: "build_plan", description: "Create a routine the robot runs on its own, e.g. welcome each arriving guest, guide them to a car and present it.",
    parameters: { type: "OBJECT", properties: {
      name: { type: "STRING" },
      trigger: { type: "STRING", enum: ["guest_arrives", "now"] },
      steps: { type: "ARRAY", items: { type: "OBJECT", properties: {
        action: { type: "STRING", enum: ["greet", "guide_to_car", "present_car", "show_facts", "offer_test_drive", "call_consultant", "return_home"] },
        car_id: { type: "STRING", enum: carIds },
        note: { type: "STRING", description: "What to focus on in this step" } }, required: ["action"] } } },
      required: ["name", "trigger", "steps"] } },
  { name: "run_plan", description: "Run the latest plan now in the simulation (a guest walks in and the routine starts).", parameters: { type: "OBJECT", properties: {} } },
  { name: "go_home", description: "Go back to your spot at the reception desk.", parameters: { type: "OBJECT", properties: {} } },
  { name: "call_consultant", description: "Ask a human sales consultant to come over.", parameters: { type: "OBJECT", properties: { note: { type: "STRING" } } } },
];

// ---------------------------------------------------------------- chat UI
const log = $("log");
function scroll() { log.scrollTop = log.scrollHeight; }
function hideHero() { $("hero").hidden = true; }
function bubble(who, text) {
  hideHero();
  const el = document.createElement("div"); el.className = "msg " + who;
  el.innerHTML = `<p></p>`; el.querySelector("p").textContent = text; log.appendChild(el); scroll();
  return { el, set(t) { el.querySelector("p").textContent = t; scroll(); }, done() { el.classList.remove("live"); } };
}
function chip(html, cls = "") {
  hideHero();
  const el = document.createElement("div"); el.className = "chip " + cls; el.innerHTML = html; log.appendChild(el); scroll(); return el;
}
let walkChip = null;
function walkChipStart(car, eta) {
  walkChip = chip(`<span class="ic walk"></span><span>Walking to <b>${esc(byId(car).name)}</b> with the guest</span><em>~${eta}s</em><i class="bar"><i></i></i>`, "move");
}

let plan = null;
function planCard(p) {
  hideHero();
  const el = document.createElement("div"); el.className = "plan";
  const label = { greet: "Greet the guest", guide_to_car: "Walk them to", present_car: "Present", show_facts: "Show key facts of", offer_test_drive: "Offer a test drive",
                  call_consultant: "Call a consultant", return_home: "Return to reception" };
  el.innerHTML = `<div class="ph"><span class="k">Plan</span><b>${esc(p.name)}</b><small>${p.trigger === "guest_arrives" ? "Runs when a guest walks in" : "Runs now"}</small></div>
    <ol>${p.steps.map(s => `<li><span>${label[s.action] || s.action}${s.car_id ? " " + esc(byId(s.car_id)?.name || s.car_id) : ""}</span>${s.note ? `<small>${esc(s.note)}</small>` : ""}</li>`).join("")}</ol>
    <div class="pa"><button class="run">Simulate a guest walking in</button></div>`;
  el.querySelector(".run").onclick = () => runPlan(p);
  log.appendChild(el); scroll(); p.el = el; return el;
}

// ---------------------------------------------------------------- world
const world = await createWorld({ stage: $("stage"), pip: $("pipFrame"), onEvent });
$("loading").hidden = true;

function onEvent(t, d) {
  if (t === "progress" && walkChip) walkChip.querySelector(".bar i").style.width = Math.round(d * 100) + "%";
  if (t === "arrive" && walkChip) { walkChip.classList.add("done"); walkChip.querySelector("em").textContent = "arrived"; walkChip = null; }
  if (t === "camera") document.querySelectorAll("[data-cam]").forEach(b => b.classList.toggle("on", b.dataset.cam === d));
  if (t === "tap") guestTapped(d);
  if (t === "walk") lastEta = d.eta;
}

// ---------------------------------------------------------------- brain
let mode = CFG.key || CFG.tokenUrl ? "live" : "local";
const local = new LocalVoice();
let robotBubble = null, guestBubble = null, planRunning = false;

const live = new Live({
  endpoint, model: CFG.model, voice: CFG.voice, system: systemPrompt, tools: TOOLS, onTool: runTool,
  on: {
    state(s, why) {
      const map = { connecting: ["Connecting", "wait"], live: ["Live", "on"], closed: ["Ready", ""] };
      const [txt, cls] = map[s] || [s, ""];
      $("status").textContent = txt; $("status").className = "status " + cls;
      if (s === "closed" && why && /key|auth|permission|not found|invalid|connect/i.test(why) && !live.everReady) fallBack(why);
      if (s === "live") live.everReady = true;
      setMicUi();
    },
    heard(t) { if (!guestBubble) guestBubble = bubble("guest live", t); else guestBubble.set(t); },
    heardDone(t) { if (guestBubble) { guestBubble.set(t); guestBubble.done(); guestBubble = null; } },
    said(t) { if (!robotBubble) robotBubble = bubble("robot live", t); else robotBubble.set(t); world.caption(t.split(/(?<=[.!?؟])\s+/).slice(-1)[0]); },
    saidDone(t) { if (robotBubble) { robotBubble.set(t); robotBubble.done(); robotBubble = null; } },
    speaking(on) { world.setSpeaking(on); $("talk").classList.toggle("on", on); },
    level(v) { $("mic").style.setProperty("--lvl", Math.min(1, v * 9).toFixed(2)); },
  },
});

function fallBack(why) {
  mode = "local";
  chip(`<span class="ic warn"></span><span>Live voice unavailable (${esc(String(why).slice(0, 80))}). Running the offline demo brain.</span>`, "warn");
  $("status").textContent = "Offline demo"; $("status").className = "status off";
}

async function runTool(name, a) {
  if (name === "walk_to_car") {
    const c = byId(a.car_id); if (!c) return { ok: false, error: "unknown car" };
    const p = world.walkToCar(c.id);
    walkChipStart(c.id, lastEta);
    p.then(ok => { if (ok && !planRunning) arrivedNote(c); });
    return { ok: true, walking_to: c.name, eta_seconds: lastEta, note: "You are walking now with the guest beside you. Talk while you walk: one or two sentences. Wait for [ARRIVED] before presenting." };
  }
  if (name === "show_on_screen") {
    world.screen(a.view, a.car_id || world.presenting);
    chip(`<span class="ic screen"></span><span>Screen: ${a.view === "facts" ? "key facts" : a.view}${a.car_id ? " · " + esc(byId(a.car_id)?.name) : ""}</span>`);
    return { ok: true };
  }
  if (name === "build_plan") {
    plan = { name: a.name || "Welcome routine", trigger: a.trigger || "guest_arrives", steps: (a.steps || []).filter(s => s && s.action) };
    planCard(plan);
    return { ok: true, note: "The plan card is in the chat with a button to simulate a guest walking in. Describe the plan in one or two sentences." };
  }
  if (name === "run_plan") {
    if (!plan) return { ok: false, error: "no plan yet" };
    setTimeout(() => runPlan(plan), 2500);
    return { ok: true, note: "Starting in a moment: a guest will walk in. Say one short line that you're starting." };
  }
  if (name === "go_home") { world.goHome(); return { ok: true }; }
  if (name === "call_consultant") {
    chip(`<span class="ic person"></span><span>Consultant called${a.note ? ": " + esc(a.note) : ""}</span>`);
    return { ok: true, note: "A consultant is on the way, about two minutes." };
  }
  return { ok: false, error: "unknown tool" };
}
let lastEta = 10;

async function arrivedNote(c) {
  if (mode !== "live") return;
  await live.quiet();
  if (world.presenting !== c.id) return;
  live.text(`[ARRIVED] You and the guest are now standing at the ${c.name}. Your screen shows it. Present it now.`, "Event");
}

async function guestTapped(id) {
  const c = byId(id); if (!c) return;
  chip(`<span class="ic screen"></span><span>Guest tapped <b>${esc(c.name)}</b> on the robot screen</span>`);
  if (mode === "live") live.text(`[EVENT] The guest tapped the ${c.name} on your screen. Take them to it.`, "Event");
  else localAct(c.name);
}

// ---------------------------------------------------------------- sending
async function sendText(t) {
  t = t.trim(); if (!t) return;
  bubble("guest", t);
  if (mode === "live") {
    robotBubble = null;
    const ok = await live.text(t);
    if (!ok && mode === "live") fallBack("could not connect");
    if (mode === "live") return;
  }
  localAct(t);
}

// offline brain: keyword routing with lines built from the car data
function matchCar(t) {
  t = t.toLowerCase();
  const rules = [[/(7|seven|سبع|٧).{0,6}(seat|seater|مقاعد|راكب)|three.?row|third row|family|عائل/, "atlas7"], [/(8|eight|ثمان).{0,6}seat|van|mpv|sliding/, "caravan8"],
    [/electric|\bev\b|charge|كهرب/, "pulse"], [/luxury|plug.?in|phev|hybrid suv|فخم/, "summit"], [/sport|fast|quick|gt\b|سريع/, "stradagt"], [/sedan|executive|economical|fuel|صالون/, "meridian"]];
  for (const c of CARS) if (t.includes(c.name.toLowerCase().split(" ")[0])) return c;
  for (const [re, id] of rules) if (re.test(t)) return byId(id);
  return null;
}
async function localSay(t) {
  const b = bubble("robot", t); world.caption(t);
  await local.say(t, on => { world.setSpeaking(on); $("talk").classList.toggle("on", on); });
  return b;
}
async function localAct(t) {
  const low = t.toLowerCase();
  if (/plan|routine|welcome|خطة/.test(low) && !/run|start|test/.test(low)) {
    plan = { name: "Welcome and guide", trigger: "guest_arrives", steps: [
      { action: "greet" }, { action: "guide_to_car", car_id: (matchCar(t) || byId("atlas7")).id }, { action: "present_car", car_id: (matchCar(t) || byId("atlas7")).id },
      { action: "offer_test_drive" }, { action: "return_home" }] };
    planCard(plan);
    return localSay("Done. Every guest who walks in gets greeted, walked to the car and a short tour, then I head back to the desk. Hit the button to watch it.");
  }
  if (/run|start|test/.test(low) && plan) return runPlan(plan);
  if (/back|home|reception|desk/.test(low)) { world.goHome(); return localSay("Heading back to the desk. Shout if you want to see another one."); }
  if (/spec|detail|number|facts|مواصف/.test(low) && world.presenting) {
    const c = byId(world.presenting); world.screen("facts", c.id);
    return localSay(`Here are the numbers on my screen. The one people ask about most: ${c.specs[2][0]} ${c.specs[2][1]}, and ${c.specs[3][0].toLowerCase()} ${c.specs[3][1]}.`);
  }
  const c = matchCar(t);
  if (c) {
    const walking = world.walkToCar(c.id);
    walkChipStart(c.id, lastEta);
    await localSay(`The ${c.name}. Come with me, it's this way. ${c.points[0]}.`);
    if (await walking) await localSay(`Here it is. ${c.tagline} ${c.points[1]}. ${c.key[0][0]} ${c.key[0][1]}, ${c.price}. Who will be driving it most?`);
    return;
  }
  if (/price|cost|how much|كم/.test(low) && world.presenting) { const p = byId(world.presenting); return localSay(`The ${p.name} starts ${p.price.replace("from ", "at ")}. A consultant can walk you through offers and finance.`); }
  return localSay("We have six on the floor: two seven-plus seaters, a luxury plug-in hybrid, an efficient sedan, a sports sedan and an electric hatch. Tell me what you drive now and who rides with you.");
}

// ---------------------------------------------------------------- plan runner
async function narrate(liveText, localText) {
  if (mode === "live") { await live.text(liveText, "Event"); await live.answered(); }
  else await localSay(localText);
}
async function runPlan(p) {
  if (planRunning) return; planRunning = true;
  const lis = p.el ? [...p.el.querySelectorAll("li")] : [];
  p.el && p.el.classList.add("running");
  chip(`<span class="ic person"></span><span>A guest walks in through the door</span>`);
  world.setCamera("follow");
  await world.guestArrives();
  let car = null;
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i], c = s.car_id ? byId(s.car_id) : car; if (s.car_id) car = c;
    const nextCar = p.steps.slice(i + 1).find(x => x.car_id);
    lis.forEach((li, k) => { li.classList.toggle("now", k === i); li.classList.toggle("done", k < i); });
    const note = s.note ? ` Focus: ${s.note}.` : "";
    if (s.action === "greet") {
      await narrate(`[PLAN STEP] A guest just walked in and you are face to face. Welcome them in one or two short sentences like a sharp human host${nextCar ? `, and say you'll show them the ${byId(nextCar.car_id).name}` : ""}. Do not call tools.${note}`,
                    `Welcome in. ${nextCar ? `Let me show you the ${byId(nextCar.car_id).name}, it's our most popular one this month.` : "Take a look around, I'm right here."}`);
    } else if (s.action === "guide_to_car" && c) {
      const walking = world.walkToCar(c.id); walkChipStart(c.id, lastEta);
      await narrate(`[PLAN STEP] You are now walking the guest to the ${c.name}. Talk while you walk, one or two sentences. Do not call tools.${note}`, `This way. ${c.points[0]}.`);
      await walking;
    } else if (s.action === "present_car" && c) {
      world.screen("car", c.id);
      await narrate(`[PLAN STEP] You are at the ${c.name} with the guest. Present it in about 20 seconds, end with one question. Do not call tools.${note}`,
                    `Here it is, the ${c.name}. ${c.tagline} ${c.points[1]}. ${c.points[2]}. Who would be driving it most?`);
    } else if (s.action === "show_facts" && c) {
      world.screen("facts", c.id);
      await narrate(`[PLAN STEP] Your screen now shows the key facts of the ${c.name}. Mention the two numbers that matter most. Do not call tools.${note}`,
                    `The numbers are on my screen: ${c.specs[1][1]}, and ${c.specs[3][0].toLowerCase()} ${c.specs[3][1]}.`);
    } else if (s.action === "offer_test_drive") {
      await narrate(`[PLAN STEP] Offer a test drive today, one sentence. Do not call tools.${note}`, "Want to feel it on the road? I can book you a test drive right now.");
    } else if (s.action === "call_consultant") {
      chip(`<span class="ic person"></span><span>Consultant called</span>`);
      await narrate(`[PLAN STEP] Tell the guest a consultant is coming over. One sentence. Do not call tools.`, "I've called one of our consultants, they'll be with you in a couple of minutes.");
    } else if (s.action === "return_home") {
      world.goHome();
    }
  }
  lis.forEach(li => { li.classList.remove("now"); li.classList.add("done"); });
  p.el && p.el.classList.remove("running");
  planRunning = false;
}

// ---------------------------------------------------------------- controls
const input = $("input");
$("composer").onsubmit = e => { e.preventDefault(); const t = input.value; input.value = ""; autosize(); sendText(t); };
input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); } });
function autosize() { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px"; }
input.addEventListener("input", autosize);
document.querySelectorAll("[data-say]").forEach(b => b.onclick = () => sendText(b.dataset.say));

function setMicUi() { $("mic").classList.toggle("on", !!live.mic); $("micLabel").textContent = live.mic ? "Listening" : ""; }
$("mic").onclick = async () => {
  if (mode !== "live") { chip(`<span class="ic warn"></span><span>Voice needs the live connection (add your key in config.local.js).</span>`, "warn"); return; }
  if (live.mic) { live.stopMic(); setMicUi(); return; }
  try {
    const ok = await live.startMic();
    if (!ok) fallBack("could not connect");
    else if (!log.querySelector(".msg")) live.text("[EVENT] The guest just started talking to you by voice. Don't greet with a generic line; wait for what they say.", "Event");
  } catch (e) { chip(`<span class="ic warn"></span><span>Microphone blocked: ${esc(e.message)}</span>`, "warn"); }
  setMicUi();
};
document.querySelectorAll("[data-cam]").forEach(b => b.onclick = () => world.setCamera(b.dataset.cam));
$("arrive").onclick = () => plan ? runPlan(plan) : (async () => { await world.guestArrives(); if (mode === "live") live.text("[EVENT] A new guest just walked in and you are face to face. Welcome them in one short sentence, like a sharp human host.", "Event"); else localSay("Welcome in. Have a look around, and tell me what you're driving now."); })();
$("pipToggle").onclick = () => $("pip").classList.toggle("min");
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => live.ctx(), { once: true });
if (!CFG.tokenUrl) start();
else lockGate();

function start() {
  if (mode === "live") live.connect();
  else { $("status").textContent = "Offline demo"; $("status").className = "status off"; }
}

// password gate (website): the showroom runs behind a blurred card until the password checks out on the server
function lockGate() {
  document.body.classList.add("locked"); world.attract(true);
  const form = $("gate"), pass = $("gatePass"), msg = $("gateMsg");
  const unlock = async p => {
    form.classList.add("busy"); msg.textContent = "";
    try {
      await fetchToken(p);
      try { sessionStorage.setItem(PASS_KEY, p); } catch (_) {}
      document.body.classList.remove("locked"); world.attract(false); start();
      setTimeout(() => $("input").focus(), 600);
    } catch (e) {
      msg.textContent = /wrong/.test(e.message) ? "That's not it. Try again." : "Can't reach the server right now.";
      form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake"); pass.select();
    }
    form.classList.remove("busy");
  };
  form.onsubmit = e => { e.preventDefault(); if (pass.value) unlock(pass.value); };
  if (storedPass()) unlock(storedPass()); else setTimeout(() => pass.focus(), 300);
}
window.__sim = { world, live, sendText, runPlan, get plan() { return plan; } };
