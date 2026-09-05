// ---- Config ----
const SUPABASE_URL = "https://yontcnqyosjcjhxjzzdq.supabase.co";
const SUPABASE_KEY = "sb_publishable_-kwUgVg_19Q42OIfdWi-6g_UMpaOs_d";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const RAIN_THRESHOLD_MM = 0.2; // precipitation above this counts as "rain"
const CUTOFF_HOUR = 15; // 3pm

// ---- Local state ----
let deviceId = localStorage.getItem("rc_device_id");
if (!deviceId) {
  deviceId = crypto.randomUUID();
  localStorage.setItem("rc_device_id", deviceId);
}

let city = JSON.parse(localStorage.getItem("rc_city") || "null"); // {name, lat, lon, timezone}
let profile = null;

const $ = (sel) => document.querySelector(sel);
const toast = (msg, ms = 2500) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
};

function todayStrInTz(tz) {
  // Returns YYYY-MM-DD for "now" in the given IANA timezone
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(now); // en-CA gives YYYY-MM-DD
}

function hourInTz(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false });
  return parseInt(fmt.format(now), 10);
}

// ---- Profile ----
async function ensureProfile() {
  let { data, error } = await sb.from("profiles").select("*").eq("device_id", deviceId).maybeSingle();
  if (error) console.error(error);
  if (!data) {
    const { data: created, error: insErr } = await sb
      .from("profiles")
      .insert({ device_id: deviceId })
      .select()
      .single();
    if (insErr) console.error(insErr);
    data = created;
  }
  profile = data;
  renderStats();
}

function renderStats() {
  if (!profile) return;
  $("#stat-streak").textContent = profile.current_streak;
  $("#stat-best").textContent = profile.best_streak;
  const acc = profile.total_predictions > 0 ? Math.round((profile.total_correct / profile.total_predictions) * 100) : 0;
  $("#stat-acc").textContent = acc + "%";
  $("#username-input").value = profile.username || "";
}

// ---- City setup ----
async function geocodeCity(name) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`);
  const json = await res.json();
  if (!json.results || json.results.length === 0) return null;
  const r = json.results[0];
  return { name: `${r.name}${r.admin1 ? ", " + r.admin1 : ""}${r.country ? ", " + r.country : ""}`, lat: r.latitude, lon: r.longitude, timezone: r.timezone };
}

async function setCity(cityObj) {
  city = cityObj;
  localStorage.setItem("rc_city", JSON.stringify(city));
  $("#city-card").classList.add("hidden");
  $("#predict-card").classList.remove("hidden");
  $("#leaderboard-card").classList.remove("hidden");
  $("#name-card").classList.remove("hidden");
  $("#city-label").textContent = city.name;
  await refreshForecastHint();
  await refreshTodayState();
}

$("#city-submit").addEventListener("click", async () => {
  const val = $("#city-input").value.trim();
  if (!val) return;
  toast("Looking up city…");
  const result = await geocodeCity(val);
  if (!result) { toast("City not found, try again"); return; }
  await setCity(result);
});

$("#loc-btn").addEventListener("click", () => {
  if (!navigator.geolocation) { toast("Geolocation not supported"); return; }
  toast("Getting your location…");
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await setCity({ name: "Your Location", lat, lon, timezone: tz });
  }, () => toast("Location permission denied"));
});

// ---- Forecast hint (today, before prediction) ----
async function refreshForecastHint() {
  if (!city) return;
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=precipitation_probability&timezone=${encodeURIComponent(city.timezone)}&forecast_days=1`
    );
    const json = await res.json();
    const hours = json.hourly.time;
    const probs = json.hourly.precipitation_probability;
    const idx = hours.findIndex((h) => new Date(h).getHours() === CUTOFF_HOUR);
    const prob = idx >= 0 ? probs[idx] : null;
    $("#forecast-hint").textContent = prob !== null
      ? `Official forecast: ${prob}% chance of rain by 3pm. Think you know better?`
      : `Make your call for today.`;
  } catch (e) {
    $("#forecast-hint").textContent = "Make your call for today.";
  }
}

// ---- Today's prediction state ----
async function refreshTodayState() {
  const today = todayStrInTz(city.timezone);
  const { data } = await sb
    .from("predictions")
    .select("*")
    .eq("profile_id", profile.id)
    .eq("prediction_date", today)
    .eq("question_type", "rain_by_3pm")
    .maybeSingle();

  const choiceRow = $("#choice-row");
  const lockedMsg = $("#locked-msg");

  if (data) {
    choiceRow.classList.add("hidden");
    lockedMsg.classList.remove("hidden");
    if (data.resolved) {
      lockedMsg.textContent = data.correct
        ? `✅ You called it! It ${data.actual_value === "yes" ? "did" : "did not"} rain.`
        : `❌ Missed it. It ${data.actual_value === "yes" ? "did" : "did not"} rain — you said ${data.predicted_value}.`;
    } else {
      lockedMsg.textContent = `You predicted "${data.predicted_value}". Check back after 3pm for the result!`;
    }
  } else {
    choiceRow.classList.remove("hidden");
    lockedMsg.classList.add("hidden");
  }
}

document.querySelectorAll(".choice").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const val = btn.dataset.val;
    const today = todayStrInTz(city.timezone);
    const { error } = await sb.from("predictions").insert({
      profile_id: profile.id,
      prediction_date: today,
      city: city.name,
      lat: city.lat,
      lon: city.lon,
      question_type: "rain_by_3pm",
      predicted_value: val,
    });
    if (error) {
      toast("Could not save — maybe already predicted today?");
      console.error(error);
    } else {
      toast("Prediction locked in! 🔒");
    }
    await refreshTodayState();
  });
});

// ---- Username ----
$("#username-save").addEventListener("click", async () => {
  const name = $("#username-input").value.trim().slice(0, 20);
  const { error } = await sb.from("profiles").update({ username: name || null }).eq("id", profile.id);
  if (!error) {
    profile.username = name;
    toast("Name saved");
    loadLeaderboard();
  }
});

// ---- Resolve past unresolved predictions for this profile ----
async function resolvePastPredictions() {
  const today = todayStrInTz(city ? city.timezone : "UTC");
  const { data: unresolved } = await sb
    .from("predictions")
    .select("*")
    .eq("profile_id", profile.id)
    .eq("resolved", false)
    .lt("prediction_date", today);

  if (!unresolved || unresolved.length === 0) return;

  for (const pred of unresolved) {
    try {
      const res = await fetch(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${pred.lat}&longitude=${pred.lon}&start_date=${pred.prediction_date}&end_date=${pred.prediction_date}&hourly=precipitation&timezone=auto`
      );
      const json = await res.json();
      const hours = json.hourly.time;
      const precs = json.hourly.precipitation;
      // sum precipitation from midnight to 3pm
      let total = 0;
      for (let i = 0; i < hours.length; i++) {
        const h = new Date(hours[i]).getHours();
        if (h <= CUTOFF_HOUR) total += precs[i] || 0;
      }
      const actual = total >= RAIN_THRESHOLD_MM ? "yes" : "no";
      const correct = actual === pred.predicted_value;

      await sb.from("predictions").update({ actual_value: actual, correct, resolved: true }).eq("id", pred.id);

      const newStreak = correct ? profile.current_streak + 1 : 0;
      const newBest = Math.max(profile.best_streak, newStreak);
      const newTotal = profile.total_predictions + 1;
      const newCorrect = profile.total_correct + (correct ? 1 : 0);

      await sb.from("profiles").update({
        current_streak: newStreak,
        best_streak: newBest,
        total_predictions: newTotal,
        total_correct: newCorrect,
      }).eq("id", profile.id);

      profile.current_streak = newStreak;
      profile.best_streak = newBest;
      profile.total_predictions = newTotal;
      profile.total_correct = newCorrect;
    } catch (e) {
      console.error("Resolution failed for", pred.id, e);
    }
  }
  renderStats();
}

// ---- Leaderboard ----
async function loadLeaderboard() {
  const { data, error } = await sb.from("leaderboard").select("*").limit(10);
  if (error) { console.error(error); return; }
  const list = $("#leaderboard-list");
  list.innerHTML = "";
  data.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "lb-row";
    div.innerHTML = `<span><span class="lb-rank">${i + 1}.</span>${row.username}</span><span>🔥 ${row.current_streak} (best ${row.best_streak})</span>`;
    list.appendChild(div);
  });
}

// ---- Init ----
(async function init() {
  await ensureProfile();
  if (city) {
    $("#city-card").classList.add("hidden");
    $("#predict-card").classList.remove("hidden");
    $("#leaderboard-card").classList.remove("hidden");
    $("#name-card").classList.remove("hidden");
    $("#city-label").textContent = city.name;
    await refreshForecastHint();
    await refreshTodayState();
    await resolvePastPredictions();
  }
  await loadLeaderboard();
})();
