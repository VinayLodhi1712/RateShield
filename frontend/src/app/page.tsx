'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Shield,
  Activity,
  Zap,
  Flame,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Trash2,
  User,
  LogIn,
  LogOut,
  Clock,
  Server,
  Database,
  Radio,
  Play,
  Square,
  Lock,
} from 'lucide-react';

const API_BASE = typeof window !== 'undefined' && window.location.port === '3000' ? '' : 'http://localhost:3000';
const GAUGE_CIRCUMFERENCE = 527.78; // 2 * pi * 84

interface UserData {
  id: number;
  email: string;
  role: string;
}

interface TelemetryLog {
  id: string;
  time: string;
  method: string;
  endpoint: string;
  status: number;
  remaining: string | number;
  latencyMs: number;
  requestId: string;
  policyName?: string;
  algorithm?: string;
}

interface HealthData {
  status: string;
  apiLatency: number;
  redisLatency: number | null;
  redisStatus: string;
  dbLatency: number | null;
  dbStatus: string;
}

export default function Dashboard() {
  // Auth state
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<UserData | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [authEmail, setAuthEmail] = useState('developer@rateshield.io');
  const [authPassword, setAuthPassword] = useState('password123');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  // Health state
  const [health, setHealth] = useState<HealthData>({
    status: 'checking',
    apiLatency: 0,
    redisLatency: null,
    redisStatus: 'checking',
    dbLatency: null,
    dbStatus: 'checking',
  });

  // Rate limit state
  const [selectedEndpoint, setSelectedEndpoint] = useState('GET /health');
  const [limit, setLimit] = useState(100);
  const [remaining, setRemaining] = useState(100);
  const [windowSeconds, setWindowSeconds] = useState(60);
  const [resetCountdown, setResetCountdown] = useState(60);
  const [algorithm, setAlgorithm] = useState('Fixed Window');
  const [policyName, setPolicyName] = useState('Default Global Policy');
  const nextResetEpochRef = useRef(Math.floor(Date.now() / 1000) + 60);

  // Telemetry & Burst state
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);
  const [allowedCount, setAllowedCount] = useState(0);
  const [blockedCount, setBlockedCount] = useState(0);
  const [isAutoStreaming, setIsAutoStreaming] = useState(false);
  const autoStreamIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load auth on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('rateshield_token');
    const savedUser = localStorage.getItem('rateshield_user');
    if (savedToken && savedUser) {
      setAuthToken(savedToken);
      setCurrentUser(JSON.parse(savedUser));
    }
  }, []);

  // Poll Health
  const fetchHealth = useCallback(async () => {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/health`);
      const latency = Date.now() - start;
      const json = await res.json();

      if (json.success) {
        const comp = json.data.components;
        setHealth({
          status: json.data.status,
          apiLatency: latency,
          redisLatency: comp?.redis?.latencyMs ?? null,
          redisStatus: comp?.redis?.status || 'unhealthy',
          dbLatency: comp?.postgres?.latencyMs ?? null,
          dbStatus: comp?.postgres?.status || 'unhealthy',
        });
      }
    } catch {
      setHealth((prev) => ({ ...prev, status: 'offline', apiLatency: 0 }));
    }
  }, []);

  // Poll Rate Limit Status (Read Only)
  const fetchRateLimitStatus = useCallback(async () => {
    const url = `${API_BASE}/rate-limit/status?endpoint=${encodeURIComponent(selectedEndpoint)}`;
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return;
      const json = await res.json();
      if (json.success && json.data) {
        const { policy, state } = json.data;
        setLimit(policy.limitCount);
        setRemaining(state.remaining);
        setWindowSeconds(policy.windowSeconds);
        setAlgorithm(policy.algorithm === 'fixed_window' ? 'Fixed Window' : policy.algorithm);
        setPolicyName(policy.name);

        if (state.resetAt) {
          nextResetEpochRef.current = Math.floor(new Date(state.resetAt).getTime() / 1000);
        }
      }
    } catch {
      // ignore
    }
  }, [selectedEndpoint, authToken]);

  useEffect(() => {
    fetchHealth();
    fetchRateLimitStatus();
    const healthTimer = setInterval(fetchHealth, 4000);

    const countdownTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      const diff = Math.max(0, nextResetEpochRef.current - now);
      setResetCountdown(diff);
      if (diff === 0) {
        nextResetEpochRef.current = now + windowSeconds;
      }
    }, 1000);

    return () => {
      clearInterval(healthTimer);
      clearInterval(countdownTimer);
    };
  }, [fetchHealth, fetchRateLimitStatus, windowSeconds]);

  // Handle Auth
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsAuthLoading(true);

    const endpoint = isRegisterMode ? '/auth/register' : '/auth/login';
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error?.message || 'Authentication failed');
      }

      setAuthToken(data.data.accessToken);
      setCurrentUser(data.data.user);
      localStorage.setItem('rateshield_token', data.data.accessToken);
      localStorage.setItem('rateshield_user', JSON.stringify(data.data.user));
      setIsAuthModalOpen(false);
      fetchRateLimitStatus();
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Auth failed');
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleLogout = () => {
    setAuthToken(null);
    setCurrentUser(null);
    localStorage.removeItem('rateshield_token');
    localStorage.removeItem('rateshield_user');
    fetchRateLimitStatus();
  };

  // Dispatch Request Batch
  const sendBurst = async (count: number) => {
    const [method, path] = selectedEndpoint.split(' ');
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    for (let i = 0; i < count; i++) {
      const start = Date.now();
      try {
        const body = method === 'POST' ? JSON.stringify({ email: 'test@rateshield.io', password: 'password123' }) : undefined;
        const res = await fetch(`${API_BASE}${path}`, {
          method,
          headers,
          body,
        });

        const latencyMs = Date.now() - start;
        const status = res.status;
        const remainingHdr = res.headers.get('X-RateLimit-Remaining');
        const limitHdr = res.headers.get('X-RateLimit-Limit');
        const reqId = res.headers.get('X-Request-Id') || 'req_client';

        if (status === 200 || status === 201) {
          setAllowedCount((c) => c + 1);
        } else if (status === 429) {
          setBlockedCount((c) => c + 1);
        }

        if (remainingHdr !== null) {
          const remVal = parseInt(remainingHdr, 10);
          setRemaining(remVal);
          if (limitHdr) setLimit(parseInt(limitHdr, 10));
        }

        const newLog: TelemetryLog = {
          id: Math.random().toString(36).slice(2),
          time: new Date().toLocaleTimeString(),
          method,
          endpoint: path,
          status,
          remaining: remainingHdr ?? '--',
          latencyMs,
          requestId: reqId,
        };

        setTelemetryLogs((prev) => [newLog, ...prev.slice(0, 49)]);
      } catch {
        const newLog: TelemetryLog = {
          id: Math.random().toString(36).slice(2),
          time: new Date().toLocaleTimeString(),
          method,
          endpoint: path,
          status: 500,
          remaining: '--',
          latencyMs: Date.now() - start,
          requestId: 'err_network',
        };
        setTelemetryLogs((prev) => [newLog, ...prev.slice(0, 49)]);
      }
    }
  };

  // Auto Traffic Generator Toggle
  const toggleAutoStream = () => {
    if (isAutoStreaming) {
      if (autoStreamIntervalRef.current) clearInterval(autoStreamIntervalRef.current);
      setIsAutoStreaming(false);
    } else {
      setIsAutoStreaming(true);
      autoStreamIntervalRef.current = setInterval(() => {
        sendBurst(1);
      }, 500);
    }
  };

  // Gauge calculations
  const ratio = Math.max(0, Math.min(1, remaining / limit));
  const strokeOffset = GAUGE_CIRCUMFERENCE - ratio * GAUGE_CIRCUMFERENCE;
  const gaugeColor = ratio < 0.2 ? '#f43f5e' : ratio < 0.5 ? '#f59e0b' : '#06b6d4';

  return (
    <div className="flex flex-col min-h-screen">
      {/* Top Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#07090e]/80 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-indigo-500/20 to-cyan-500/20 border border-white/10 shadow-[0_0_20px_rgba(99,102,241,0.3)]">
              <Shield className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
                RateShield
              </h1>
              <p className="text-xs text-slate-400">Distributed Token & Window Telemetry</p>
            </div>
          </div>

          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border ${
            health.status === 'healthy'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
          }`}>
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                health.status === 'healthy' ? 'bg-emerald-400' : 'bg-amber-400'
              }`} />
              <span className={`relative inline-flex rounded-full h-2 w-2 ${
                health.status === 'healthy' ? 'bg-emerald-500' : 'bg-amber-500'
              }`} />
            </span>
            {health.status === 'healthy' ? 'All Systems Operational' : 'Degraded (Standalone Mode)'}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Health Metrics */}
          <div className="hidden lg:flex items-center gap-4 px-3.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-xs text-slate-400 font-mono">
            <div className="flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-cyan-400" /> API: <span className="text-white font-semibold">{health.apiLatency}ms</span>
            </div>
            <div className="w-px h-3 bg-white/10" />
            <div className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-indigo-400" /> Redis: <span className={`font-semibold ${health.redisStatus === 'healthy' ? 'text-emerald-400' : 'text-amber-400'}`}>
                {health.redisLatency !== null ? `${health.redisLatency}ms` : 'Offline'}
              </span>
            </div>
            <div className="w-px h-3 bg-white/10" />
            <div className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-purple-400" /> Postgres: <span className={`font-semibold ${health.dbStatus === 'healthy' ? 'text-emerald-400' : 'text-amber-400'}`}>
                {health.dbLatency !== null ? `${health.dbLatency}ms` : 'Offline'}
              </span>
            </div>
          </div>

          {/* User Auth Info */}
          {currentUser ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300 font-medium">
                <User className="w-3.5 h-3.5" />
                <span>{currentUser.email}</span>
                <span className="px-1.5 py-0.2 rounded bg-indigo-500/30 text-[10px] uppercase font-bold text-indigo-200">
                  {currentUser.role}
                </span>
              </div>
              <button
                onClick={handleLogout}
                className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 hover:bg-rose-500/20 transition"
                title="Logout"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setIsRegisterMode(false);
                setIsAuthModalOpen(true);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs shadow-[0_0_15px_rgba(99,102,241,0.4)] transition"
            >
              <LogIn className="w-3.5 h-3.5" /> Login / Register
            </button>
          )}
        </div>
      </header>

      {/* Main Dashboard Layout */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Gauge & Burst Generator */}
        <section className="lg:col-span-5 flex flex-col gap-6">
          {/* Rate Limit Circular Gauge Card */}
          <div className="glass-panel p-6 rounded-2xl flex flex-col items-center gap-6 relative overflow-hidden">
            <div className="w-full flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-cyan-400" />
                <h2 className="font-semibold text-white">Live Rate Limit Gauge</h2>
              </div>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-500/15 border border-purple-500/30 text-purple-300">
                {policyName}
              </span>
            </div>

            {/* SVG Ring Gauge */}
            <div className="relative w-52 h-52 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 200 200">
                <circle
                  cx="100"
                  cy="100"
                  r="84"
                  className="stroke-white/5"
                  strokeWidth="12"
                  fill="transparent"
                />
                <circle
                  cx="100"
                  cy="100"
                  r="84"
                  stroke={gaugeColor}
                  strokeWidth="12"
                  strokeDasharray={GAUGE_CIRCUMFERENCE}
                  strokeDashoffset={strokeOffset}
                  strokeLinecap="round"
                  fill="transparent"
                  className="transition-all duration-300 ease-out"
                />
              </svg>
              <div className="absolute flex flex-col items-center">
                <span className="text-4xl font-bold font-mono text-white tracking-tight">
                  {remaining}
                </span>
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wider mt-0.5">
                  Quota Remaining
                </span>
              </div>
            </div>

            {/* Status Metric Grid */}
            <div className="grid grid-cols-2 gap-3 w-full">
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col">
                <span className="text-[11px] uppercase text-slate-400 font-semibold tracking-wider">Capacity Limit</span>
                <span className="text-lg font-bold font-mono text-white mt-0.5">{limit} reqs</span>
              </div>
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col">
                <span className="text-[11px] uppercase text-slate-400 font-semibold tracking-wider">Window Size</span>
                <span className="text-lg font-bold font-mono text-white mt-0.5">{windowSeconds}s</span>
              </div>
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col">
                <span className="text-[11px] uppercase text-slate-400 font-semibold tracking-wider flex items-center gap-1">
                  <Clock className="w-3 h-3 text-cyan-400" /> Reset Countdown
                </span>
                <span className="text-lg font-bold font-mono text-cyan-400 mt-0.5">{resetCountdown}s</span>
              </div>
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col">
                <span className="text-[11px] uppercase text-slate-400 font-semibold tracking-wider">Algorithm</span>
                <span className="text-lg font-bold text-indigo-400 mt-0.5 truncate">{algorithm}</span>
              </div>
            </div>
          </div>

          {/* Traffic Burst Controls */}
          <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Flame className="w-5 h-5 text-rose-400" />
              <h3 className="font-semibold text-white">Interactive Traffic Generator</h3>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Dispatch concurrent request bursts to test Lua atomicity and trigger 429 throttling in real time.
            </p>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-300">Target Endpoint</label>
              <select
                value={selectedEndpoint}
                onChange={(e) => setSelectedEndpoint(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition"
              >
                <option value="GET /health">GET /health (Global Limit - 100 req/60s)</option>
                <option value="POST /auth/login">POST /auth/login (Strict IP - 5 req/60s)</option>
                <option value="GET /rate-limit/status">GET /rate-limit/status (Inspection - Read Only)</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-1">
              <button
                onClick={() => sendBurst(1)}
                className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-semibold text-xs bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_0_15px_rgba(99,102,241,0.3)] transition"
              >
                <Zap className="w-3.5 h-3.5" /> Send 1 Ping
              </button>
              <button
                onClick={() => sendBurst(5)}
                className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-semibold text-xs bg-cyan-600 hover:bg-cyan-500 text-white shadow-[0_0_15px_rgba(6,182,212,0.3)] transition"
              >
                <Flame className="w-3.5 h-3.5" /> Burst 5 Reqs
              </button>
              <button
                onClick={() => sendBurst(15)}
                className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-semibold text-xs bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_15px_rgba(168,85,247,0.3)] transition"
              >
                <Flame className="w-3.5 h-3.5" /> Burst 15 Reqs
              </button>
              <button
                onClick={() => sendBurst(50)}
                className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-semibold text-xs bg-rose-600 hover:bg-rose-500 text-white shadow-[0_0_15px_rgba(244,63,94,0.3)] transition"
              >
                <Flame className="w-3.5 h-3.5" /> Burst 50 Reqs
              </button>
            </div>

            <div className="pt-2 border-t border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <Radio className={`w-4 h-4 ${isAutoStreaming ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
                <span>Continuous Stream (2 req/s)</span>
              </div>
              <button
                onClick={toggleAutoStream}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                  isAutoStreaming
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
                    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
                }`}
              >
                {isAutoStreaming ? (
                  <>
                    <Square className="w-3 h-3" /> Stop Stream
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3" /> Start Stream
                  </>
                )}
              </button>
            </div>
          </div>
        </section>

        {/* Right Column: Live Telemetry Logs */}
        <section className="lg:col-span-7 flex flex-col gap-6">
          <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 flex-1">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-indigo-400" />
                <h2 className="font-semibold text-white">Live Request Telemetry</h2>
              </div>
              <div className="flex items-center gap-3">
                <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> {allowedCount} Allowed
                </span>
                <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {blockedCount} Blocked (429)
                </span>
                <button
                  onClick={() => {
                    setTelemetryLogs([]);
                    setAllowedCount(0);
                    setBlockedCount(0);
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition"
                  title="Clear telemetry logs"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-xl border border-white/5 bg-black/20 flex-1 max-h-[580px]">
              <table className="w-full text-left text-xs font-mono">
                <thead className="sticky top-0 bg-[#0d1424] text-slate-400 border-b border-white/10 uppercase text-[10px] tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Method</th>
                    <th className="px-4 py-3">Endpoint</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Remaining</th>
                    <th className="px-4 py-3">Latency</th>
                    <th className="px-4 py-3">Request ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.03]">
                  {telemetryLogs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-16 text-slate-500 font-sans">
                        No requests recorded yet. Click a burst button on the left to start testing!
                      </td>
                    </tr>
                  ) : (
                    telemetryLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-white/[0.02] transition">
                        <td className="px-4 py-2.5 text-slate-400">{log.time}</td>
                        <td className="px-4 py-2.5 font-bold text-slate-200">{log.method}</td>
                        <td className="px-4 py-2.5 text-slate-300 truncate max-w-[140px]">{log.endpoint}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded font-bold text-[11px] ${
                              log.status === 200 || log.status === 201
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : log.status === 429
                                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30 animate-pulse'
                                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            }`}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-cyan-300 font-bold">{log.remaining}</td>
                        <td className="px-4 py-2.5 text-slate-400">{log.latencyMs}ms</td>
                        <td className="px-4 py-2.5 text-slate-500 truncate max-w-[100px]">{log.requestId}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      {/* Auth Modal */}
      {isAuthModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl bg-[#0f172a] shadow-2xl border border-white/10 flex flex-col gap-4">
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <h3 className="font-semibold text-white text-base flex items-center gap-2">
                <Lock className="w-4 h-4 text-indigo-400" />
                {isRegisterMode ? 'Register Developer Account' : 'Sign In to RateShield'}
              </h3>
              <button
                onClick={() => setIsAuthModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 bg-black/40 p-1 rounded-xl">
              <button
                onClick={() => setIsRegisterMode(false)}
                className={`py-1.5 rounded-lg text-xs font-semibold transition ${
                  !isRegisterMode ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Sign In
              </button>
              <button
                onClick={() => setIsRegisterMode(true)}
                className={`py-1.5 rounded-lg text-xs font-semibold transition ${
                  isRegisterMode ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Register
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-slate-300">Email Address</label>
                <input
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="bg-black/40 border border-white/10 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-slate-300">Password</label>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="bg-black/40 border border-white/10 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  required
                  minLength={8}
                />
              </div>

              {authError && (
                <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={isAuthLoading}
                className="mt-2 py-2.5 rounded-xl font-semibold text-xs bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_0_15px_rgba(99,102,241,0.4)] transition disabled:opacity-50"
              >
                {isAuthLoading ? 'Processing...' : isRegisterMode ? 'Create Account' : 'Sign In'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
