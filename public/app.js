// ---- Config ----
const SUPABASE_URL = "https://yontcnqyosjcjhxjzzdq.supabase.co";
const SUPABASE_KEY = "sb_publishable_-kwUgVg_19Q42OIfdWi-6g_UMpaOs_d";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const RAIN_THRESHOLD_MM = 1.0; // total mm across the day before we call it "rain" — filters out trace/drizzle noise in the forecast model
const CUTOFF_HOUR = 15; // 3pm

const $ = (sel) => document.querySelector(sel);
const toast = (msg, ms = 2500) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
};

let city = JSON.parse(localStorage.getItem("rc_city") || "null");
let session = null;
let profile = null;

function todayStrInTz(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(now);
}

// ---- Avatar helpers ----
function initialsFor(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function renderAvatarButton(name, avatarUrl) {
  const btn = $("#avatar-btn");
  if (avatarUrl) {
    btn.innerHTML = `<img src="${avatarUrl}" alt="${name}" referrerpolicy="no-referrer" />`;
    btn.style.background = "transparent";
  } else {
    btn.textContent = initialsFor(name);
    btn.style.background = colorFor(name || "?");
  }
  $("#avatar-wrap").classList.remove("hidden");
  $("#avatar-menu-name").textContent = name;
}

function smallAvatarHtml(name, avatarUrl) {
  if (avatarUrl) {
    return `<img src="${avatarUrl}" alt="" referrerpolicy="no-referrer" style="width:24px;height:24px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px;" />`;
  }
  const initials = initialsFor(name);
  const bg = colorFor(name || "?");
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:${bg};color:#fff;font-size:0.65rem;font-weight:800;vertical-align:middle;margin-right:8px;">${initials}</span>`;
}

// ---- Auth ----
$("#google-btn").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) toast("Google sign-in isn't set up yet — try email instead");
});

$("#email-btn").addEventListener("click", async () => {
  const email = $("#email-input").value.trim();
  if (!email) return;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) {
    $("#auth-status").textContent = "Something went wrong — try again.";
  } else {
    $("#auth-status").textContent = `Check ${email} for a sign-in link.`;
  }
});

$("#avatar-btn").addEventListener("click", () => {
  $("#avatar-menu").classList.toggle("hidden");
});

$("#signout-btn").addEventListener("click", async () => {
  await sb.auth.signOut();
  window.location.reload();
});

async function ensureProfile() {
  const user = session.user;
  let { data, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) console.error(error);

  if (!data) {
    // First time this account has ever signed in — ask what to call them.
    const suggested =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      (user.email ? user.email.split("@")[0] : "Player");
    $("#namepicker-input").value = suggested;
    $("#namepicker-card").classList.remove("hidden");
    $("#namepicker-save").onclick = async () => {
      const chosen = $("#namepicker-input").value.trim().slice(0, 20) || suggested;
      const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
      const { data: created, error: insErr } = await sb
        .from("profiles")
        .insert({ id: user.id, display_name: chosen, avatar_url: avatarUrl })
        .select()
        .single();
      if (insErr) { console.error(insErr); toast("Could not save profile"); return; }
      profile = created;
      $("#namepicker-card").classList.add("hidden");
      renderAvatarButton(profile.display_name, profile.avatar_url);
      renderStats();
      afterAuthReady();
    };
    return; // wait for name picker submission
  }

  profile = data;
  renderAvatarButton(profile.display_name, profile.avatar_url);
  renderStats();
  afterAuthReady();
}

function renderStats() {
  if (!profile) return;
  $("#stat-streak").textContent = profile.current_streak;
  $("#stat-best").textContent = profile.best_streak;
  const acc = profile.total_predictions > 0 ? Math.round((profile.total_correct / profile.total_predictions) * 100) : 0;
  $("#stat-acc").textContent = acc + "%";
}

// Runs once we have both a session and a profile row.
async function afterAuthReady() {
  $("#auth-card").classList.add("hidden");
  if (city) {
    await enterCityMode();
  } else {
    $("#city-card").classList.remove("hidden");
  }
  await loadLeaderboard();
}

// ---- Countdown to 3pm ----
let countdownInterval = null;

function secondsSinceMidnightInTz(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  let h = get("hour");
  if (h === 24) h = 0;
  return h * 3600 + get("minute") * 60 + get("second");
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  const cutoffSeconds = CUTOFF_HOUR * 3600;

  function tick() {
    const elapsed = secondsSinceMidnightInTz(city.timezone);
    const remaining = cutoffSeconds - elapsed;
    const wrap = $("#countdown-wrap");

    if (remaining <= 0) {
      wrap.classList.add("hidden");
      clearInterval(countdownInterval);
      return;
    }
    wrap.classList.remove("hidden");
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    $("#countdown-time").textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    const pctElapsed = ((cutoffSeconds - remaining) / cutoffSeconds) * 100;
    $("#countdown-bar-fill").style.width = `${Math.min(100, pctElapsed)}%`;
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

// ---- City setup ----
async function geocodeCity(name) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`);
  const json = await res.json();
  if (!json.results || json.results.length === 0) return null;
  const r = json.results[0];
  return { name: `${r.name}${r.admin1 ? ", " + r.admin1 : ""}${r.country ? ", " + r.country : ""}`, lat: r.latitude, lon: r.longitude, timezone: r.timezone };
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const json = await res.json();
    const city = json.city || json.locality || json.principalSubdivision;
    const country = json.countryName;
    if (city && country) return `${city}, ${country}`;
    if (city) return city;
    return "Your Location";
  } catch (e) {
    return "Your Location";
  }
}

async function enterCityMode() {
  $("#city-card").classList.add("hidden");
  $("#predict-card").classList.remove("hidden");
  $("#leaderboard-card").classList.remove("hidden");
  $("#city-label").textContent = city.name;
  await refreshForecastHint();
  await refreshTodayState();
  await resolveTodayIfPastCutoff();
  await resolvePastPredictions();
  startCountdown();
}

async function setCity(cityObj) {
  city = cityObj;
  localStorage.setItem("rc_city", JSON.stringify(city));
  await enterCityMode();
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
    const name = await reverseGeocode(lat, lon);
    await setCity({ name, lat, lon, timezone: tz });
  }, () => toast("Location permission denied"));
});

$("#change-city-btn").addEventListener("click", () => {
  localStorage.removeItem("rc_city");
  city = null;
  $("#predict-card").classList.add("hidden");
  $("#leaderboard-card").classList.add("hidden");
  $("#city-card").classList.remove("hidden");
  toast("Pick a new city or use your location");
});

// ---- Forecast hint ----
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

// ---- Today's prediction ----
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
  const countdownWrap = $("#countdown-wrap");

  if (data) {
    choiceRow.classList.add("hidden");
    lockedMsg.classList.remove("hidden");
    lockedMsg.classList.remove("result-good", "result-bad", "reveal-pop");
    if (data.resolved) {
      countdownWrap.classList.add("hidden");
      if (data.correct) {
        lockedMsg.textContent = `✅ You called it! It ${data.actual_value === "yes" ? "did" : "did not"} rain.`;
        lockedMsg.classList.add("result-good", "reveal-pop");
      } else {
        lockedMsg.textContent = `❌ Missed it. It ${data.actual_value === "yes" ? "did" : "did not"} rain — you said ${data.predicted_value}.`;
        lockedMsg.classList.add("result-bad");
      }
    } else {
      lockedMsg.textContent = `You predicted "${data.predicted_value}". Hang tight for the reveal!`;
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

// ---- Resolve TODAY's prediction the moment 3pm passes (same-day, not tomorrow) ----
async function resolveTodayIfPastCutoff() {
  const elapsed = secondsSinceMidnightInTz(city.timezone);
  if (elapsed < CUTOFF_HOUR * 3600) return; // not 3pm yet

  const today = todayStrInTz(city.timezone);
  const { data: pred } = await sb
    .from("predictions")
    .select("*")
    .eq("profile_id", profile.id)
    .eq("prediction_date", today)
    .eq("question_type", "rain_by_3pm")
    .eq("resolved", false)
    .maybeSingle();

  if (!pred) return;

  try {
    // Today's data isn't in the archive yet — use the forecast endpoint, which
    // also carries already-elapsed hours of the current day.
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${pred.lat}&longitude=${pred.lon}&hourly=precipitation&timezone=${encodeURIComponent(city.timezone)}&forecast_days=1`
    );
    const json = await res.json();
    const hours = json.hourly.time;
    const precs = json.hourly.precipitation;
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
    renderStats();
    await refreshTodayState();
  } catch (e) {
    console.error("Same-day resolution failed", e);
  }
}

// ---- Resolve past predictions ----
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
    div.innerHTML = `
      <span class="lb-left">
        <span class="lb-rank">${i + 1}</span>
        ${smallAvatarHtml(row.display_name, row.avatar_url)}
        <span>${row.display_name}</span>
      </span>
      <span class="lb-streak">🔥 ${row.current_streak} <span style="color:var(--text-dim); font-weight:400;">(best ${row.best_streak})</span></span>`;
    list.appendChild(div);
  });
}

// ---- Init: wire up auth state ----
sb.auth.onAuthStateChange((_event, newSession) => {
  session = newSession;
});

(async function init() {
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session) {
    await ensureProfile();
  }
  // else: auth-card (shown by default) stays visible until they sign in
})();
