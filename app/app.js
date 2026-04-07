// API calls go through the local proxy to avoid CORS issues
const BASE = '/api';
const COMP = 'PL';

// DOM elements
const homeSelect = document.getElementById('homeTeam');
const awaySelect = document.getElementById('awayTeam');
const predictBtn = document.getElementById('predictBtn');
const resultsSection = document.getElementById('results');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');

let teamsData = [];
let matchesCache = {}; // season -> matches

// ── API helpers ──

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
  return res.json();
}

function showLoading(msg) {
  loadingText.textContent = msg;
  loadingOverlay.classList.add('active');
}

function hideLoading() {
  loadingOverlay.classList.remove('active');
}

// ── Load teams ──

async function loadTeams() {
  showLoading('Loading Premier League teams...');
  try {
    const data = await apiFetch(`${BASE}/competitions/${COMP}/teams`);
    teamsData = data.teams.sort((a, b) => a.shortName.localeCompare(b.shortName));

    teamsData.forEach(team => {
      const optH = new Option(team.shortName, team.id);
      const optA = new Option(team.shortName, team.id);
      homeSelect.add(optH);
      awaySelect.add(optA);
    });
  } catch (err) {
    alert('Failed to load teams. Check your API key and try again.\n' + err.message);
  }
  hideLoading();
}

// ── Load matches for a season ──

async function loadMatches(season) {
  if (matchesCache[season]) return matchesCache[season];
  const data = await apiFetch(
    `${BASE}/competitions/${COMP}/matches?season=${season}&status=FINISHED`
  );
  matchesCache[season] = data.matches;
  return data.matches;
}

// ── Gather matches from current + previous season ──

async function getAllMatches() {
  const currentYear = new Date().getFullYear();
  // PL season spans two calendar years. The "season" param is the start year.
  // If we're before August, current season started last year.
  const month = new Date().getMonth(); // 0-indexed
  const currentSeason = month < 7 ? currentYear - 1 : currentYear;
  const prevSeason = currentSeason - 1;

  showLoading('Fetching match history...');
  const [current, prev] = await Promise.all([
    loadMatches(currentSeason),
    loadMatches(prevSeason),
  ]);
  hideLoading();
  return [...prev, ...current];
}

// ── Stats calculation ──

function calcTeamStats(matches, teamId, venue) {
  // venue: 'home' | 'away' | 'all'
  const relevant = matches.filter(m => {
    if (venue === 'home') return m.homeTeam.id === teamId;
    if (venue === 'away') return m.awayTeam.id === teamId;
    return m.homeTeam.id === teamId || m.awayTeam.id === teamId;
  });

  let goals = 0, conceded = 0, wins = 0, draws = 0, losses = 0;

  relevant.forEach(m => {
    const isHome = m.homeTeam.id === teamId;
    const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    goals += gf;
    conceded += ga;
    if (gf > ga) wins++;
    else if (gf === ga) draws++;
    else losses++;
  });

  const n = relevant.length || 1;
  return {
    played: relevant.length,
    avgGoals: goals / n,
    avgConceded: conceded / n,
    winRate: wins / n,
    drawRate: draws / n,
    lossRate: losses / n,
  };
}

function getForm(matches, teamId, count = 5) {
  // Most recent matches for this team
  const teamMatches = matches
    .filter(m => m.homeTeam.id === teamId || m.awayTeam.id === teamId)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, count);

  return teamMatches.map(m => {
    const isHome = m.homeTeam.id === teamId;
    const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    if (gf > ga) return 'W';
    if (gf === ga) return 'D';
    return 'L';
  });
}

function getH2H(matches, homeId, awayId, count = 5) {
  return matches
    .filter(m =>
      (m.homeTeam.id === homeId && m.awayTeam.id === awayId) ||
      (m.homeTeam.id === awayId && m.awayTeam.id === homeId)
    )
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, count);
}

// ── Prediction model ──
// Simple weighted model combining:
//   - Home/away goal averages (attack + defense)
//   - Recent form
//   - Head-to-head record
//   - Home advantage bias

function predict(matches, homeId, awayId) {
  const homeStats = calcTeamStats(matches, homeId, 'home');
  const awayStats = calcTeamStats(matches, awayId, 'away');
  const homeOverall = calcTeamStats(matches, homeId, 'all');
  const awayOverall = calcTeamStats(matches, awayId, 'all');

  const homeForm = getForm(matches, homeId);
  const awayForm = getForm(matches, awayId);
  const h2hMatches = getH2H(matches, homeId, awayId);

  // Expected goals using attack/defense strength
  // League average ~1.4 goals per team per game
  const leagueAvg = calcLeagueAvg(matches);

  const homeAttack = homeStats.avgGoals / (leagueAvg.homeGoals || 1.4);
  const homeDefense = homeStats.avgConceded / (leagueAvg.awayGoals || 1.2);
  const awayAttack = awayStats.avgGoals / (leagueAvg.awayGoals || 1.2);
  const awayDefense = awayStats.avgConceded / (leagueAvg.homeGoals || 1.4);

  // Expected goals (Poisson-style expected values)
  let homeXG = homeAttack * awayDefense * (leagueAvg.homeGoals || 1.4);
  let awayXG = awayAttack * homeDefense * (leagueAvg.awayGoals || 1.2);

  // Form adjustment: +/- based on recent form
  const formWeight = 0.15;
  const homeFormScore = formScore(homeForm);
  const awayFormScore = formScore(awayForm);
  homeXG *= 1 + (homeFormScore - 0.5) * formWeight;
  awayXG *= 1 + (awayFormScore - 0.5) * formWeight;

  // H2H adjustment
  if (h2hMatches.length > 0) {
    const h2hWeight = 0.1;
    const h2hScore = calcH2HBias(h2hMatches, homeId);
    homeXG *= 1 + (h2hScore - 0.5) * h2hWeight;
    awayXG *= 1 - (h2hScore - 0.5) * h2hWeight;
  }

  // Clamp
  homeXG = Math.max(0.3, Math.min(4.0, homeXG));
  awayXG = Math.max(0.2, Math.min(3.5, awayXG));

  // Calculate outcome probabilities using Poisson distribution
  const probs = poissonMatchProbs(homeXG, awayXG);

  return {
    homeXG: Math.round(homeXG * 10) / 10,
    awayXG: Math.round(awayXG * 10) / 10,
    predictedHome: Math.round(homeXG),
    predictedAway: Math.round(awayXG),
    homeWin: probs.homeWin,
    draw: probs.draw,
    awayWin: probs.awayWin,
    homeForm,
    awayForm,
    h2hMatches,
    homeStats,
    awayStats,
  };
}

function calcLeagueAvg(matches) {
  let homeGoals = 0, awayGoals = 0, count = 0;
  matches.forEach(m => {
    if (m.score.fullTime.home != null) {
      homeGoals += m.score.fullTime.home;
      awayGoals += m.score.fullTime.away;
      count++;
    }
  });
  const n = count || 1;
  return { homeGoals: homeGoals / n, awayGoals: awayGoals / n };
}

function formScore(form) {
  // W=1, D=0.4, L=0 → average
  if (form.length === 0) return 0.5;
  const pts = form.reduce((s, r) => s + (r === 'W' ? 1 : r === 'D' ? 0.4 : 0), 0);
  return pts / form.length;
}

function calcH2HBias(h2hMatches, homeId) {
  // Returns 0-1 score favoring homeId
  if (h2hMatches.length === 0) return 0.5;
  let score = 0;
  h2hMatches.forEach(m => {
    const isHome = m.homeTeam.id === homeId;
    const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    if (gf > ga) score += 1;
    else if (gf === ga) score += 0.4;
  });
  return score / h2hMatches.length;
}

// Poisson probability: P(k) = (λ^k * e^-λ) / k!
function poisson(lambda, k) {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) {
    result *= lambda / i;
  }
  return result;
}

function poissonMatchProbs(homeXG, awayXG) {
  let homeWin = 0, draw = 0, awayWin = 0;
  const maxGoals = 7;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisson(homeXG, h) * poisson(awayXG, a);
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
    }
  }

  // Normalize
  const total = homeWin + draw + awayWin;
  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
  };
}

// ── Render results ──

function renderResults(prediction, homeName, awayName) {
  resultsSection.style.display = 'block';

  // Probability bar
  const hw = (prediction.homeWin * 100).toFixed(0);
  const dw = (prediction.draw * 100).toFixed(0);
  const aw = (prediction.awayWin * 100).toFixed(0);

  document.getElementById('homeProb').style.width = hw + '%';
  document.getElementById('drawProb').style.width = dw + '%';
  document.getElementById('awayProb').style.width = aw + '%';
  document.getElementById('homeProbLabel').textContent = `${homeName} ${hw}%`;
  document.getElementById('drawProbLabel').textContent = `Draw ${dw}%`;
  document.getElementById('awayProbLabel').textContent = `${awayName} ${aw}%`;

  // Predicted score
  document.getElementById('homeScoreName').textContent = homeName;
  document.getElementById('awayScoreName').textContent = awayName;
  document.getElementById('predictedHome').textContent = prediction.predictedHome;
  document.getElementById('predictedAway').textContent = prediction.predictedAway;

  // Form badges
  renderForm('homeForm', prediction.homeForm);
  renderForm('awayForm', prediction.awayForm);

  // Stat values
  document.getElementById('homeAvgGoals').textContent = prediction.homeStats.avgGoals.toFixed(2);
  document.getElementById('awayAvgGoals').textContent = prediction.awayStats.avgGoals.toFixed(2);
  document.getElementById('homeAvgConceded').textContent = prediction.homeStats.avgConceded.toFixed(2);
  document.getElementById('awayAvgConceded').textContent = prediction.awayStats.avgConceded.toFixed(2);

  // H2H
  renderH2H(prediction.h2hMatches);

  // Scroll into view
  resultsSection.scrollIntoView({ behavior: 'smooth' });
}

function renderForm(containerId, form) {
  const el = document.getElementById(containerId);
  el.innerHTML = form
    .map(r => `<span class="form-badge ${r}">${r}</span>`)
    .join('');
}

function renderH2H(h2hMatches) {
  const el = document.getElementById('h2hResults');
  if (h2hMatches.length === 0) {
    el.innerHTML = '<p style="color:#888">No recent meetings found</p>';
    return;
  }
  el.innerHTML = h2hMatches
    .map(m => {
      const date = new Date(m.utcDate).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      });
      const score = `${m.homeTeam.shortName} ${m.score.fullTime.home} – ${m.score.fullTime.away} ${m.awayTeam.shortName}`;
      return `<div class="h2h-match">
        <span class="h2h-score">${score}</span>
        <span class="h2h-date">${date}</span>
      </div>`;
    })
    .join('');
}

// ── Event handlers ──

function updateCrest(selectEl, crestEl) {
  const id = parseInt(selectEl.value);
  const team = teamsData.find(t => t.id === id);
  if (team && team.crest) {
    crestEl.innerHTML = `<img src="${team.crest}" alt="${team.shortName}">`;
  } else {
    crestEl.innerHTML = '';
  }
}

function checkSelections() {
  const h = homeSelect.value;
  const a = awaySelect.value;
  predictBtn.disabled = !h || !a || h === a;
}

homeSelect.addEventListener('change', () => {
  updateCrest(homeSelect, document.getElementById('homeCrest'));
  checkSelections();
});

awaySelect.addEventListener('change', () => {
  updateCrest(awaySelect, document.getElementById('awayCrest'));
  checkSelections();
});

predictBtn.addEventListener('click', async () => {
  const homeId = parseInt(homeSelect.value);
  const awayId = parseInt(awaySelect.value);
  const homeTeam = teamsData.find(t => t.id === homeId);
  const awayTeam = teamsData.find(t => t.id === awayId);

  predictBtn.disabled = true;
  predictBtn.textContent = 'Analyzing...';

  try {
    const matches = await getAllMatches();
    const prediction = predict(matches, homeId, awayId);
    renderResults(prediction, homeTeam.shortName, awayTeam.shortName);
  } catch (err) {
    alert('Prediction failed: ' + err.message);
  }

  predictBtn.disabled = false;
  predictBtn.textContent = 'Predict Match';
});

// ── Init ──
loadTeams();
