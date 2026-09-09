// ---- Config ----
const SUPABASE_URL = "https://yontcnqyosjcjhxjzzdq.supabase.co";
const SUPABASE_KEY = "sb_publishable_-kwUgVg_19Q42OIfdWi-6g_UMpaOs_d";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (sel) => document.querySelector(sel);
const toast = (msg, ms = 2500) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
};

let session = null;
let profile = null;
let todayChallenge = null;
let questions = [];
let currentQIndex = 0;
let sessionScore = 0;
let categoryResults = [];
let questionStartTime = 0;
let qTimerInterval = null;

const CATEGORY_ICONS = { logic: "🧩", speed: "⚡", memory: "🧠", visual: "👁️", pattern: "🔷" };

function initialsFor(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 60%, 50%)`;
}
function avatarHtml(name, url, size = 24) {
  if (url) return `<img src="${url}" alt="" referrerpolicy="no-referrer" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;vertical-align:middle;" />`;
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${colorFor(name || "?")};color:#fff;font-size:${size * 0.4}px;font-weight:800;vertical-align:middle;">${initialsFor(name)}</span>`;
}

// ---- Auth ----
$("#google-btn").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  if (error) toast("Google sign-in isn't set up yet — try email instead");
});

$("#email-btn").addEventListener("click", async () => {
  const email = $("#email-input").value.trim();
  if (!email) return;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  $("#auth-status").textContent = error ? "Something went wrong — try again." : `Check ${email} for a sign-in link.`;
});

$("#avatar-btn").addEventListener("click", () => $("#avatar-menu").classList.toggle("hidden"));
$("#signout-btn").addEventListener("click", async () => { await sb.auth.signOut(); window.location.reload(); });
$("#nav-profile-btn").addEventListener("click", () => { $("#avatar-menu").classList.add("hidden"); showProfile(); });
$("#nav-leaderboard-btn").addEventListener("click", () => { $("#avatar-menu").classList.add("hidden"); showLeaderboard(); });
$("#view-leaderboard-from-home").addEventListener("click", showLeaderboard);
$("#result-leaderboard-btn").addEventListener("click", showLeaderboard);

async function ensureProfile() {
  const user = session.user;
  let { data } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();

  if (!data) {
    const suggested = user.user_metadata?.full_name || user.user_metadata?.name || (user.email ? user.email.split("@")[0] : "Player");
    $("#namepicker-input").value = suggested;
    $("#namepicker-card").classList.remove("hidden");
    $("#namepicker-save").onclick = async () => {
      const chosen = $("#namepicker-input").value.trim().slice(0, 20) || suggested;
      const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
      const { data: created, error } = await sb.from("profiles").insert({ id: user.id, display_name: chosen, avatar_url: avatarUrl }).select().single();
      if (error) { toast("Could not save profile"); return; }
      profile = created;
      $("#namepicker-card").classList.add("hidden");
      renderAvatarButton();
      afterAuthReady();
    };
    return;
  }
  profile = data;
  renderAvatarButton();
  afterAuthReady();
}

function renderAvatarButton() {
  const btn = $("#avatar-btn");
  if (profile.avatar_url) {
    btn.innerHTML = `<img src="${profile.avatar_url}" referrerpolicy="no-referrer" />`;
    btn.style.background = "transparent";
  } else {
    btn.textContent = initialsFor(profile.display_name);
    btn.style.background = colorFor(profile.display_name);
  }
  $("#avatar-wrap").classList.remove("hidden");
  $("#avatar-menu-name").textContent = profile.display_name;
}

async function afterAuthReady() {
  $("#auth-card").classList.add("hidden");
  await loadTodayChallenge();
  showHome();
}

// ---- Load today's challenge ----
async function loadTodayChallenge() {
  const { data: challenge } = await sb.from("daily_challenges").select("*").eq("published", true).order("day_number", { ascending: false }).limit(1).maybeSingle();
  if (!challenge) { toast("No battle available right now"); return; }
  todayChallenge = challenge;
  const { data: qs } = await sb.from("challenge_questions").select("*").eq("daily_challenge_id", challenge.id).order("order_index");
  questions = qs || [];
}

// ---- Reset countdown (UTC midnight, global for everyone) ----
function startResetCountdown() {
  function tick() {
    const now = new Date();
    const nextUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    const diff = nextUtcMidnight - now;
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    $("#hero-countdown").textContent = `${h}:${m}:${s}`;
  }
  tick();
  setInterval(tick, 1000);
}

// ---- Views ----
function hideAllViews() {
  ["home-view", "battle-view", "result-view", "leaderboard-view", "profile-view"].forEach((id) => $(`#${id}`).classList.add("hidden"));
}

async function showHome() {
  hideAllViews();
  $("#home-view").classList.remove("hidden");
  $("#hero-day-num").textContent = todayChallenge ? todayChallenge.day_number : "1";
  $("#hero-streak").textContent = `🔥 ${profile.current_streak}`;

  const { count } = await sb.from("daily_results").select("id", { count: "exact", head: true }).eq("daily_challenge_id", todayChallenge.id).not("completed_at", "is", null);
  $("#hero-players").textContent = count ?? 0;

  const { data: myResult } = await sb.from("daily_results").select("*").eq("profile_id", profile.id).eq("daily_challenge_id", todayChallenge.id).maybeSingle();
  if (myResult && myResult.completed_at) {
    $("#already-played-card").style.display = "block";
    $("#already-played-text").textContent = `You scored ${myResult.total_score}/500 today. Come back tomorrow for a new battle!`;
    $("#play-btn").textContent = "REVIEW YOUR RESULT";
  } else {
    $("#already-played-card").style.display = "none";
    $("#play-btn").textContent = "PLAY TODAY'S BATTLE";
  }

  await renderLeaderboard("#home-leaderboard-list", 5, false);
}

$("#play-btn").addEventListener("click", async () => {
  const { data: myResult } = await sb.from("daily_results").select("*").eq("profile_id", profile.id).eq("daily_challenge_id", todayChallenge.id).maybeSingle();
  if (myResult && myResult.completed_at) { showResultFromExisting(myResult); return; }
  startBattle();
});

// ---- Battle flow ----
function startBattle() {
  hideAllViews();
  $("#battle-view").classList.remove("hidden");
  $("#battle-countdown").classList.remove("hidden");
  $("#question-card").classList.add("hidden");
  currentQIndex = 0;
  sessionScore = 0;
  categoryResults = [];

  let n = 3;
  $("#countdown-num").textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n > 0) {
      $("#countdown-num").textContent = n;
      $("#countdown-num").style.animation = "none";
      void $("#countdown-num").offsetWidth;
      $("#countdown-num").style.animation = "";
    } else if (n === 0) {
      $("#countdown-num").textContent = "GO!";
    } else {
      clearInterval(iv);
      $("#battle-countdown").classList.add("hidden");
      $("#question-card").classList.remove("hidden");
      showQuestion();
    }
  }, 700);
}

function showQuestion() {
  const q = questions[currentQIndex];
  $("#q-num").textContent = currentQIndex + 1;
  $("#q-category").textContent = `${CATEGORY_ICONS[q.category] || "🔹"} ${q.category.toUpperCase()}`;
  $("#q-prompt").textContent = q.prompt;
  $("#live-score-num").textContent = sessionScore;
  $("#points-flash").classList.add("hidden");

  const optionsWrap = $("#q-options");
  optionsWrap.innerHTML = "";
  q.options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.textContent = opt;
    btn.addEventListener("click", () => handleAnswer(opt, btn));
    optionsWrap.appendChild(btn);
  });

  questionStartTime = Date.now();
  let remaining = q.time_limit_seconds;
  const timerEl = $("#q-timer");
  const fillEl = $("#q-timer-fill");
  timerEl.classList.remove("low");
  fillEl.style.width = "100%";
  updateTimerDisplay(remaining);

  if (qTimerInterval) clearInterval(qTimerInterval);
  qTimerInterval = setInterval(() => {
    remaining -= 0.1;
    if (remaining <= 5) timerEl.classList.add("low");
    fillEl.style.width = `${Math.max(0, (remaining / q.time_limit_seconds) * 100)}%`;
    updateTimerDisplay(Math.max(0, remaining));
    if (remaining <= 0) {
      clearInterval(qTimerInterval);
      handleAnswer(null, null); // time's up, no answer
    }
  }, 100);
}

function updateTimerDisplay(secondsFloat) {
  const s = Math.ceil(secondsFloat);
  $("#q-timer").textContent = `00:${String(s).padStart(2, "0")}`;
}

async function handleAnswer(selected, btnEl) {
  if (qTimerInterval) clearInterval(qTimerInterval);
  const q = questions[currentQIndex];
  const timeTakenMs = Date.now() - questionStartTime;
  const isCorrect = selected === q.correct_answer;

  // Disable all buttons, show correct/incorrect state
  document.querySelectorAll(".option-btn").forEach((b) => {
    b.disabled = true;
    if (b.textContent === q.correct_answer) b.classList.add("correct");
    else if (b === btnEl) b.classList.add("incorrect");
    else b.classList.add("dimmed");
  });

  let points = 0;
  if (isCorrect) {
    const timeLimitMs = q.time_limit_seconds * 1000;
    const speedFrac = Math.max(0, Math.min(1, 1 - timeTakenMs / timeLimitMs));
    points = 80 + Math.round(speedFrac * 20); // base 80 + up to 20 speed bonus
  }
  sessionScore = Math.min(500, sessionScore + points);
  categoryResults.push({ category: q.category, correct: isCorrect });

  const flash = $("#points-flash");
  flash.textContent = isCorrect ? `+${points} POINTS` : "0 POINTS";
  flash.className = `points-flash ${isCorrect ? "good" : "bad"}`;
  flash.classList.remove("hidden");
  $("#live-score-num").textContent = sessionScore;

  // Record submission (best-effort; ignore duplicate-question errors on retry)
  try {
    await sb.from("submissions").insert({
      profile_id: profile.id,
      daily_challenge_id: todayChallenge.id,
      question_id: q.id,
      selected_answer: selected || "(no answer)",
      is_correct: isCorrect,
      time_taken_ms: timeTakenMs,
      points_earned: points,
    });
  } catch (e) { /* ignore */ }

  setTimeout(() => {
    currentQIndex++;
    if (currentQIndex < questions.length) {
      showQuestion();
    } else {
      finishBattle();
    }
  }, 1400);
}

async function finishBattle() {
  const correctCount = categoryResults.filter((c) => c.correct).length;

  await sb.from("daily_results").insert({
    profile_id: profile.id,
    daily_challenge_id: todayChallenge.id,
    total_score: sessionScore,
    completed_at: new Date().toISOString(),
  });

  // Streak logic
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let newStreak;
  if (profile.last_played_date === yesterday) newStreak = profile.current_streak + 1;
  else if (profile.last_played_date === todayStr) newStreak = profile.current_streak;
  else newStreak = 1;
  const newBestStreak = Math.max(profile.best_streak, newStreak);
  const newXp = profile.xp + 50 + (sessionScore === 500 ? 100 : 0);
  const newLevel = Math.floor(newXp / 500) + 1;

  const updates = {
    current_streak: newStreak,
    best_streak: newBestStreak,
    total_battles: profile.total_battles + 1,
    total_correct: profile.total_correct + correctCount,
    best_score: Math.max(profile.best_score, sessionScore),
    last_played_date: todayStr,
    xp: newXp,
    level: newLevel,
  };
  await sb.from("profiles").update(updates).eq("id", profile.id);
  Object.assign(profile, updates);

  showResult(sessionScore, categoryResults);
}

function showResultFromExisting(result) {
  showResult(result.total_score, null);
}

async function showResult(score, catResults) {
  hideAllViews();
  $("#result-view").classList.remove("hidden");
  $("#result-score").textContent = `${score} / 500`;

  const { data: rankRow } = await sb.from("leaderboard_today").select("rank").eq("daily_challenge_id", todayChallenge.id).eq("display_name", profile.display_name).maybeSingle();
  $("#result-rank").textContent = rankRow ? `Global Rank #${rankRow.rank} · 🔥 ${profile.current_streak} Day Streak` : `🔥 ${profile.current_streak} Day Streak`;

  const catsWrap = $("#result-cats");
  catsWrap.innerHTML = "";
  if (catResults) {
    catResults.forEach((c) => {
      const chip = document.createElement("span");
      chip.className = `result-cat-chip ${c.correct ? "ok" : "no"}`;
      chip.textContent = `${CATEGORY_ICONS[c.category] || ""} ${c.correct ? "✓" : "✗"}`;
      catsWrap.appendChild(chip);
    });
  }

  $("#result-share-btn").onclick = () => {
    const text = `🧠 DAILY BRAIN BATTLE\nDay ${todayChallenge.day_number}\nScore: ${score}/500\n🔥 ${profile.current_streak} day streak\n\nCan you beat my score?\n${window.location.origin}`;
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text);
      toast("Result copied to clipboard!");
    }
  };
}

// ---- Leaderboard ----
async function renderLeaderboard(selector, limit, showSticky) {
  if (!todayChallenge) return;
  const { data, error } = await sb.from("leaderboard_today").select("*").eq("daily_challenge_id", todayChallenge.id).order("rank").limit(limit);
  if (error) { console.error(error); return; }
  const list = $(selector);
  list.innerHTML = "";
  data.forEach((row) => {
    const isYou = row.display_name === profile.display_name;
    const div = document.createElement("div");
    div.className = `lb-row ${isYou ? "you" : ""}`;
    const rankClass = row.rank === 1 ? "top1" : row.rank === 2 ? "top2" : row.rank === 3 ? "top3" : "";
    const medal = row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : row.rank;
    div.innerHTML = `
      <span class="lb-left">
        <span class="lb-rank ${rankClass}">${medal}</span>
        ${avatarHtml(row.display_name, row.avatar_url)}
        <span>${row.display_name}${isYou ? " (you)" : ""}</span>
      </span>
      <span class="lb-score">${row.total_score}</span>`;
    list.appendChild(div);
  });

  if (showSticky) {
    const { data: mine } = await sb.from("leaderboard_today").select("*").eq("daily_challenge_id", todayChallenge.id).eq("display_name", profile.display_name).maybeSingle();
    if (mine) {
      $("#sticky-you").classList.remove("hidden");
      $("#sticky-rank").textContent = mine.rank;
      $("#sticky-score").textContent = `${mine.total_score} PTS`;
    } else {
      $("#sticky-you").classList.add("hidden");
    }
  }
}

async function showLeaderboard() {
  hideAllViews();
  $("#leaderboard-view").classList.remove("hidden");
  $("#lb-day-num").textContent = todayChallenge ? todayChallenge.day_number : "1";
  await renderLeaderboard("#leaderboard-list", 50, true);
}

// ---- Profile ----
function showProfile() {
  hideAllViews();
  $("#profile-view").classList.remove("hidden");
  $("#profile-avatar").innerHTML = profile.avatar_url
    ? `<img src="${profile.avatar_url}" referrerpolicy="no-referrer" />`
    : initialsFor(profile.display_name);
  if (!profile.avatar_url) $("#profile-avatar").style.background = colorFor(profile.display_name);
  $("#profile-name").textContent = profile.display_name;
  $("#profile-level").textContent = `Level ${profile.level} · ${profile.xp} XP`;
  $("#p-streak").textContent = profile.current_streak;
  $("#p-best-streak").textContent = profile.best_streak;
  $("#p-battles").textContent = profile.total_battles;
  $("#p-best-score").textContent = profile.best_score;
  $("#p-correct").textContent = profile.total_correct;
  $("#p-xp").textContent = profile.xp;
}

// ---- Init ----
sb.auth.onAuthStateChange((_event, newSession) => { session = newSession; });

(async function init() {
  startResetCountdown();
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session) {
    await ensureProfile();
  } else {
    $("#auth-card").classList.remove("hidden");
  }
})();
