// RateShield Dashboard Interactive Controller
const API_BASE = window.location.port === '3000' ? '' : 'http://localhost:3000';

let authToken = localStorage.getItem('rateshield_token') || null;
let currentUser = JSON.parse(localStorage.getItem('rateshield_user') || 'null');
let allowedCount = 0;
let blockedCount = 0;
let isRegisterMode = false;

const GAUGE_CIRCUMFERENCE = 527.78; // 2 * pi * 84

// DOM Elements
const systemStatusPill = document.getElementById('system-status-pill');
const systemStatusText = document.getElementById('system-status-text');
const apiLatencyEl = document.getElementById('api-latency');
const redisLatencyEl = document.getElementById('redis-latency');
const dbLatencyEl = document.getElementById('db-latency');

const gaugeCircle = document.getElementById('gauge-circle');
const gaugeRemaining = document.getElementById('gauge-remaining');
const statLimit = document.getElementById('stat-limit');
const statWindow = document.getElementById('stat-window');
const statReset = document.getElementById('stat-reset');
const statAlgo = document.getElementById('stat-algo');
const policyBadge = document.getElementById('policy-badge');

const endpointSelect = document.getElementById('endpoint-select');
const badgeAllowed = document.getElementById('badge-allowed');
const badgeBlocked = document.getElementById('badge-blocked');
const telemetryTbody = document.getElementById('telemetry-tbody');
const btnClearLogs = document.getElementById('btn-clear-logs');

const authModal = document.getElementById('auth-modal');
const btnAuthToggle = document.getElementById('btn-auth-toggle');
const btnCloseModal = document.getElementById('btn-close-modal');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const authForm = document.getElementById('auth-form');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authErrorMsg = document.getElementById('auth-error-msg');
const btnAuthSubmit = document.getElementById('btn-auth-submit');
const userBadge = document.getElementById('user-badge');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();
  fetchHealth();
  fetchRateLimitStatus();

  setInterval(fetchHealth, 4000);
  setInterval(updateResetCountdown, 1000);

  // Burst Buttons
  document.getElementById('btn-send-1').addEventListener('click', () => sendBurst(1));
  document.getElementById('btn-send-5').addEventListener('click', () => sendBurst(5));
  document.getElementById('btn-send-15').addEventListener('click', () => sendBurst(15));
  document.getElementById('btn-send-50').addEventListener('click', () => sendBurst(50));

  btnClearLogs.addEventListener('click', () => {
    telemetryTbody.innerHTML = '<tr class="empty-row"><td colspan="7">Logs cleared. Click a burst button to start testing!</td></tr>';
    allowedCount = 0;
    blockedCount = 0;
    updateCounterBadges();
  });

  // Modal events
  btnAuthToggle.addEventListener('click', () => {
    if (authToken) {
      // Logout
      authToken = null;
      currentUser = null;
      localStorage.removeItem('rateshield_token');
      localStorage.removeItem('rateshield_user');
      updateAuthUI();
      fetchRateLimitStatus();
    } else {
      openAuthModal(false);
    }
  });

  btnCloseModal.addEventListener('click', closeAuthModal);
  tabLogin.addEventListener('click', () => setAuthMode(false));
  tabRegister.addEventListener('click', () => setAuthMode(true));
  authForm.addEventListener('submit', handleAuthSubmit);
  endpointSelect.addEventListener('change', fetchRateLimitStatus);
});

// Update Auth UI State
function updateAuthUI() {
  if (authToken && currentUser) {
    userBadge.style.display = 'inline-block';
    userBadge.textContent = `👤 ${currentUser.email} (${currentUser.role || 'dev'})`;
    btnAuthToggle.textContent = 'Logout';
    btnAuthToggle.classList.replace('btn-outline', 'btn-rose');
  } else {
    userBadge.style.display = 'none';
    btnAuthToggle.textContent = 'Login / Register';
    btnAuthToggle.classList.add('btn-outline');
    btnAuthToggle.classList.remove('btn-rose');
  }
}

function openAuthModal(registerMode = false) {
  authModal.style.display = 'flex';
  setAuthMode(registerMode);
  authErrorMsg.style.display = 'none';
}

function closeAuthModal() {
  authModal.style.display = 'none';
  authForm.reset();
}

function setAuthMode(isRegister) {
  isRegisterMode = isRegister;
  authErrorMsg.style.display = 'none';
  if (isRegister) {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    document.getElementById('modal-title').textContent = 'Create Developer Account';
    btnAuthSubmit.textContent = 'Register Account';
  } else {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    document.getElementById('modal-title').textContent = 'Sign In to RateShield';
    btnAuthSubmit.textContent = 'Sign In';
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  authErrorMsg.style.display = 'none';
  const email = authEmail.value.trim();
  const password = authPassword.value;

  const endpoint = isRegisterMode ? '/auth/register' : '/auth/login';

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || 'Authentication failed.');
    }

    authToken = data.data.accessToken;
    currentUser = data.data.user;
    localStorage.setItem('rateshield_token', authToken);
    localStorage.setItem('rateshield_user', JSON.stringify(currentUser));

    updateAuthUI();
    closeAuthModal();
    fetchRateLimitStatus();
  } catch (err) {
    authErrorMsg.textContent = err.message;
    authErrorMsg.style.display = 'block';
  }
}

// Fetch Health Status
async function fetchHealth() {
  try {
    const start = Date.now();
    const res = await fetch(`${API_BASE}/health`);
    const duration = Date.now() - start;
    const json = await res.json();

    if (res.ok && json.success) {
      const data = json.data;
      apiLatencyEl.textContent = `${duration}ms`;

      if (data.components?.redis?.status === 'healthy') {
        redisLatencyEl.textContent = `${data.components.redis.latencyMs || 1}ms`;
        document.querySelector('#health-redis .metric-dot').className = 'metric-dot dot-green';
      } else {
        redisLatencyEl.textContent = 'Offline';
        document.querySelector('#health-redis .metric-dot').className = 'metric-dot dot-red';
      }

      if (data.components?.postgres?.status === 'healthy') {
        dbLatencyEl.textContent = `${data.components.postgres.latencyMs || 2}ms`;
        document.querySelector('#health-postgres .metric-dot').className = 'metric-dot dot-green';
      } else {
        dbLatencyEl.textContent = 'Offline';
        document.querySelector('#health-postgres .metric-dot').className = 'metric-dot dot-red';
      }

      if (data.status === 'healthy') {
        systemStatusPill.className = 'status-pill status-healthy';
        systemStatusText.textContent = 'All Systems Operational';
      } else {
        systemStatusPill.className = 'status-pill';
        systemStatusPill.style.background = 'rgba(245, 158, 11, 0.15)';
        systemStatusPill.style.borderColor = 'rgba(245, 158, 11, 0.3)';
        systemStatusPill.style.color = '#fbbf24';
        systemStatusText.textContent = 'Degraded (Standalone)';
      }
    }
  } catch (err) {
    systemStatusText.textContent = 'Backend Offline';
    apiLatencyEl.textContent = 'N/A';
  }
}

// Fetch Rate Limit Status
let nextResetEpochSeconds = Math.floor(Date.now() / 1000) + 60;

async function fetchRateLimitStatus() {
  const target = endpointSelect.value;
  const url = `${API_BASE}/rate-limit/status?endpoint=${encodeURIComponent(target)}`;

  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return;
    const json = await res.json();
    if (!json.success) return;

    const data = json.data;
    const policy = data.policy;
    const state = data.state;

    policyBadge.textContent = policy.name;
    statLimit.textContent = policy.limitCount;
    statWindow.textContent = `${policy.windowSeconds}s`;
    statAlgo.textContent = policy.algorithm === 'fixed_window' ? 'Fixed Window' : policy.algorithm;

    if (state.resetAt) {
      nextResetEpochSeconds = Math.floor(new Date(state.resetAt).getTime() / 1000);
    }

    updateGauge(state.remaining, policy.limitCount);
  } catch (err) {
    // fallback
  }
}

function updateGauge(remaining, limit) {
  gaugeRemaining.textContent = remaining;
  const ratio = Math.max(0, Math.min(1, remaining / limit));
  const offset = GAUGE_CIRCUMFERENCE - (ratio * GAUGE_CIRCUMFERENCE);
  gaugeCircle.style.strokeDashoffset = offset;

  if (ratio < 0.2) {
    gaugeCircle.setAttribute('stroke', '#f43f5e'); // red when almost empty
  } else if (ratio < 0.5) {
    gaugeCircle.setAttribute('stroke', '#f59e0b'); // amber
  } else {
    gaugeCircle.setAttribute('stroke', 'url(#gauge-gradient)');
  }
}

function updateResetCountdown() {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nextResetEpochSeconds - now);
  statReset.textContent = `${diff}s`;
  if (diff === 0) {
    nextResetEpochSeconds = now + 60;
  }
}

// Send Burst Requests
async function sendBurst(count) {
  const targetEndpoint = endpointSelect.value;
  const [method, path] = targetEndpoint.split(' ');

  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (method === 'POST') headers['Content-Type'] = 'application/json';

  const emptyRow = telemetryTbody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  for (let i = 0; i < count; i++) {
    const start = Date.now();
    try {
      const body = method === 'POST' ? JSON.stringify({ email: 'test@rateshield.io', password: 'password123' }) : undefined;
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body,
      });

      const duration = Date.now() - start;
      const status = res.status;
      const remainingHeader = res.headers.get('X-RateLimit-Remaining');
      const remaining = remainingHeader !== null ? remainingHeader : '--';
      const limit = res.headers.get('X-RateLimit-Limit') || 100;
      const reqId = res.headers.get('X-Request-Id') || 'req_local';

      if (status === 200 || status === 201) {
        allowedCount++;
      } else if (status === 429) {
        blockedCount++;
      }

      if (remainingHeader !== null) {
        updateGauge(parseInt(remainingHeader, 10), parseInt(limit, 10));
      }

      addTelemetryRow(method, path, status, remaining, duration, reqId);
    } catch (err) {
      addTelemetryRow(method, path, 500, '--', Date.now() - start, 'err_network');
    }

    updateCounterBadges();
  }
}

function addTelemetryRow(method, path, status, remaining, duration, reqId) {
  const row = document.createElement('tr');
  const now = new Date().toLocaleTimeString();

  const statusClass = status === 200 ? 'status-tag-200' :
                      status === 201 ? 'status-tag-201' :
                      status === 429 ? 'status-tag-429' : 'status-tag-401';

  row.innerHTML = `
    <td>${now}</td>
    <td><strong>${method}</strong></td>
    <td>${path}</td>
    <td><span class="status-tag ${statusClass}">${status}</span></td>
    <td>${remaining}</td>
    <td>${duration}ms</td>
    <td title="${reqId}">${reqId.substring(0, 12)}...</td>
  `;

  telemetryTbody.insertBefore(row, telemetryTbody.firstChild);

  // Keep table at max 50 rows
  if (telemetryTbody.children.length > 50) {
    telemetryTbody.lastElementChild.remove();
  }
}

function updateCounterBadges() {
  badgeAllowed.textContent = `${allowedCount} Allowed`;
  badgeBlocked.textContent = `${blockedCount} Blocked (429)`;
}
