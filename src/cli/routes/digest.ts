/**
 * Digest + Voice API routes — extracted from dashboard.ts
 */
import { Router } from 'express';
import express from 'express';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import type { Gateway } from '../../gateway/router.js';

export interface DigestRouterDeps {
  baseDir: string;
  vaultDir: string;
  goalsDir: string;
  memoryDbPath: string;
  parseEnvFile: () => Record<string, string>;
  getGateway: () => Promise<Gateway>;
  cached: <T>(key: string, ttlMs: number, compute: () => T) => T;
}

export function getDigestPrefs(prefsFile: string): Record<string, unknown> {
  const defaults = {
    enabled: false,
    schedule: '0 8 * * 1-5',
    channels: { email: true, discord: true, slack: false, voice: false },
    emailRecipient: '',
    sections: { summary: true, goals: true, crons: true, activity: true, metrics: true, approvals: true },
    quietHours: { start: 22, end: 8 },
  };
  if (!existsSync(prefsFile)) return defaults;
  try { return { ...defaults, ...JSON.parse(readFileSync(prefsFile, 'utf-8')) }; }
  catch { return defaults; }
}

export function digestRouter(deps: DigestRouterDeps): Router {
  const router = Router();
  const { baseDir, vaultDir, goalsDir, memoryDbPath, parseEnvFile, getGateway, cached } = deps;
  const prefsFile = path.join(baseDir, 'digest-preferences.json');
  const voiceCacheDir = path.join(baseDir, 'cache', 'voice');

  // Graph API helper for email
  let _graphTokenCache: { accessToken: string; expiresAt: number } | null = null;

  async function getGraphToken(): Promise<string> {
    if (_graphTokenCache && Date.now() < _graphTokenCache.expiresAt - 300_000) return _graphTokenCache.accessToken;
    const env = parseEnvFile();
    const tenantId = env['MS_TENANT_ID'] || '';
    const clientId = env['MS_CLIENT_ID'] || '';
    const clientSecret = env['MS_CLIENT_SECRET'] || '';
    if (!tenantId || !clientId || !clientSecret) throw new Error('Outlook not configured');
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
    const res = await fetch(tokenUrl, { method: 'POST', body });
    if (!res.ok) throw new Error(`Graph token failed: ${res.status}`);
    const data = await res.json() as { access_token: string; expires_in: number };
    _graphTokenCache = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  async function sendDigestEmail(to: string, subject: string, htmlBody: string): Promise<void> {
    const env = parseEnvFile();
    const userEmail = env['MS_USER_EMAIL'] || '';
    if (!userEmail) throw new Error('MS_USER_EMAIL not configured');
    const token = await getGraphToken();
    const message = {
      subject,
      body: { contentType: 'HTML', content: htmlBody },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${userEmail}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    if (!res.ok) { const text = await res.text(); throw new Error(`Graph sendMail ${res.status}: ${text}`); }
  }

  async function composeDigest(): Promise<{ subject: string; html: string; text: string; sections: Record<string, string> }> {
    const prefs = getDigestPrefs(prefsFile);
    const secs = (prefs.sections || {}) as Record<string, boolean>;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const sections: Record<string, string> = {};

    let officeSummary = '';
    try {
      const officeData = cached('digest-office', 30_000, () => {
        const agentsDir = path.join(vaultDir, '00-System', 'agents');
        const agents: Array<Record<string, unknown>> = [];
        if (existsSync(agentsDir)) {
          for (const slug of readdirSync(agentsDir).filter(d => !d.startsWith('_'))) {
            const agentFile = path.join(agentsDir, slug, 'agent.md');
            if (!existsSync(agentFile)) continue;
            const { data } = matter(readFileSync(agentFile, 'utf-8'));
            agents.push({ slug, name: data.name || slug, status: data.status || 'active' });
          }
        }
        return { agents };
      });
      const activeCount = officeData.agents.filter((a: Record<string, unknown>) => a.status === 'active').length;
      officeSummary = `${officeData.agents.length} agent(s), ${activeCount} active`;
    } catch { officeSummary = 'Could not load'; }

    if (secs.goals !== false) {
      try {
        if (existsSync(goalsDir)) {
          const files = readdirSync(goalsDir).filter(f => f.endsWith('.json'));
          const goals = files.map(f => { try { return JSON.parse(readFileSync(path.join(goalsDir, f), 'utf-8')); } catch { return null; } }).filter(Boolean);
          const active = goals.filter((g: Record<string, unknown>) => g.status === 'active');
          const blocked = goals.filter((g: Record<string, unknown>) => g.status === 'blocked');
          let goalText = `${active.length} active, ${blocked.length} blocked\n`;
          active.slice(0, 5).forEach((g: Record<string, unknown>) => {
            goalText += `  - ${g.title} [${g.priority}]`;
            const na = g.nextActions as string[] | undefined;
            if (na && na.length > 0) goalText += ` → ${na[0]}`;
            goalText += '\n';
          });
          sections.goals = goalText;
        }
      } catch { /* skip */ }
    }

    if (secs.crons !== false) {
      try {
        const runsDir = path.join(baseDir, 'cron', 'runs');
        if (existsSync(runsDir)) {
          let totalOk = 0, totalErr = 0, jobCount = 0;
          for (const f of readdirSync(runsDir).filter(f => f.endsWith('.jsonl'))) {
            const lines = readFileSync(path.join(runsDir, f), 'utf-8').trim().split('\n').filter(Boolean);
            const today = now.toISOString().slice(0, 10);
            const todayRuns = lines.filter(l => l.includes(today));
            if (todayRuns.length > 0) jobCount++;
            for (const l of todayRuns) {
              try { const e = JSON.parse(l); if (e.status === 'ok') totalOk++; else totalErr++; } catch { /* skip */ }
            }
          }
          sections.crons = `${jobCount} job(s) ran today: ${totalOk} succeeded, ${totalErr} failed`;
        }
      } catch { /* skip */ }
    }

    if (secs.approvals !== false) {
      try {
        if (existsSync(memoryDbPath)) {
          const Database = (await import('better-sqlite3')).default;
          const db = new Database(memoryDbPath, { readonly: true });
          try {
            const row = db.prepare("SELECT COUNT(*) as cnt FROM approval_queue WHERE status = 'pending'").get() as { cnt: number } | undefined;
            if (row && row.cnt > 0) sections.approvals = `${row.cnt} pending approval(s)`;
          } catch { /* table may not exist */ }
          db.close();
        }
      } catch { /* skip */ }
    }

    let text = `Daily Digest — ${dateStr}\n${'='.repeat(40)}\n\nTeam: ${officeSummary}\n`;
    if (sections.goals) text += `\nGoals:\n${sections.goals}`;
    if (sections.crons) text += `\nCron Jobs: ${sections.crons}\n`;
    if (sections.approvals) text += `\nApprovals: ${sections.approvals}\n`;

    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;padding:20px">
<div style="border-bottom:3px solid #ff8c21;padding-bottom:12px;margin-bottom:20px">
  <h1 style="margin:0;font-size:22px;color:#1a1a2e">Daily Digest</h1>
  <div style="color:#8a92a0;font-size:13px;margin-top:4px">${dateStr} &middot; ${officeSummary}</div>
</div>
${sections.goals ? `<div style="margin-bottom:20px"><h3 style="margin:0 0 8px;font-size:15px;color:#ff8c21">Goals</h3><pre style="margin:0;font-size:13px;color:#5a6070;white-space:pre-wrap">${sections.goals.replace(/</g, '&lt;')}</pre></div>` : ''}
${sections.crons ? `<div style="margin-bottom:20px"><h3 style="margin:0 0 8px;font-size:15px;color:#ff8c21">Cron Jobs</h3><p style="margin:0;font-size:13px;color:#5a6070">${sections.crons.replace(/</g, '&lt;')}</p></div>` : ''}
${sections.approvals ? `<div style="margin-bottom:20px"><h3 style="margin:0 0 8px;font-size:15px;color:#ff8c21">Approvals</h3><p style="margin:0;font-size:13px;color:#e5534b;font-weight:600">${sections.approvals}</p></div>` : ''}
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #d8dde5;font-size:11px;color:#8a92a0">Sent by Clementine Command Center</div>
</body></html>`;

    return { subject: `Clementine Digest — ${dateStr}`, html, text, sections };
  }

  // Preferences
  router.get('/preferences', (_req, res) => {
    res.json({ ok: true, preferences: getDigestPrefs(prefsFile) });
  });

  router.put('/preferences', express.json(), (req, res) => {
    try {
      const current = getDigestPrefs(prefsFile);
      const updated = { ...current, ...req.body };
      writeFileSync(prefsFile, JSON.stringify(updated, null, 2));
      res.json({ ok: true, preferences: updated });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Preview
  router.get('/preview', async (_req, res) => {
    try {
      const digest = await composeDigest();
      res.json({ ok: true, ...digest });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Send
  router.post('/send', async (_req, res) => {
    try {
      const prefs = getDigestPrefs(prefsFile);
      const channels = (prefs.channels || {}) as Record<string, boolean>;
      const digest = await composeDigest();
      const results: Record<string, string> = {};

      if (channels.email) {
        const recipient = (prefs.emailRecipient as string) || parseEnvFile()['MS_USER_EMAIL'] || '';
        if (recipient) {
          try { await sendDigestEmail(recipient, digest.subject, digest.html); results.email = 'sent'; }
          catch (e) { results.email = 'error: ' + String(e); }
        } else { results.email = 'skipped: no recipient'; }
      }

      if (channels.discord || channels.slack) {
        try {
          const gw = await getGateway();
          const dispatcher = (gw as any).dispatcher || (gw as any).notificationDispatcher;
          if (dispatcher && typeof dispatcher.send === 'function') {
            await dispatcher.send(`**${digest.subject}**\n\n${digest.text}`);
            results.channels = 'sent';
          } else { results.channels = 'skipped: no dispatcher'; }
        } catch (e) { results.channels = 'error: ' + String(e); }
      }

      if (channels.voice) {
        try {
          const env = parseEnvFile();
          const apiKey = env['ELEVENLABS_API_KEY'] || '';
          const voiceId = env['ELEVENLABS_VOICE_ID'] || '';
          if (apiKey && voiceId) {
            const hash = randomBytes(8).toString('hex');
            if (!existsSync(voiceCacheDir)) mkdirSync(voiceCacheDir, { recursive: true });
            const audioPath = path.join(voiceCacheDir, `${hash}.mp3`);
            const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
              method: 'POST',
              headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: digest.text.slice(0, 4000), model_id: 'eleven_multilingual_v2' }),
            });
            if (ttsRes.ok) {
              const buffer = Buffer.from(await ttsRes.arrayBuffer());
              writeFileSync(audioPath, buffer);
              results.voice = hash;
            } else { results.voice = 'error: ElevenLabs ' + ttsRes.status; }
          } else { results.voice = 'skipped: ElevenLabs not configured'; }
        } catch (e) { results.voice = 'error: ' + String(e); }
      }

      res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Test
  router.post('/test', async (_req, res) => {
    try {
      const digest = await composeDigest();
      const prefs = getDigestPrefs(prefsFile);
      const channels = (prefs.channels || {}) as Record<string, boolean>;
      const results: Record<string, string> = {};

      const recipient = (prefs.emailRecipient as string) || parseEnvFile()['MS_USER_EMAIL'] || '';
      if (recipient && channels.email) {
        try { await sendDigestEmail(recipient, '[TEST] ' + digest.subject, digest.html); results.email = 'sent'; }
        catch (e) { results.email = 'error: ' + String(e); }
      }

      if (channels.discord || channels.slack) {
        try {
          const gw = await getGateway();
          const dispatcher = (gw as any).dispatcher || (gw as any).notificationDispatcher;
          if (dispatcher && typeof dispatcher.send === 'function') {
            await dispatcher.send(`**[TEST] ${digest.subject}**\n\n${digest.text}`);
            results.channels = 'sent';
          }
        } catch (e) { results.channels = 'error: ' + String(e); }
      }

      res.json({ ok: true, results, preview: { subject: digest.subject, text: digest.text } });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // Voice synthesis
  router.post('/voice/synthesize', express.json(), async (req, res) => {
    try {
      const text = (req.body.text || '').slice(0, 5000);
      if (!text) { res.status(400).json({ ok: false, error: 'text is required' }); return; }
      const env = parseEnvFile();
      const apiKey = env['ELEVENLABS_API_KEY'] || '';
      const voiceId = env['ELEVENLABS_VOICE_ID'] || '';
      if (!apiKey || !voiceId) { res.status(400).json({ ok: false, error: 'ElevenLabs not configured' }); return; }

      const hash = randomBytes(8).toString('hex');
      if (!existsSync(voiceCacheDir)) mkdirSync(voiceCacheDir, { recursive: true });
      const audioPath = path.join(voiceCacheDir, `${hash}.mp3`);

      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      });
      if (!ttsRes.ok) { res.status(502).json({ ok: false, error: 'ElevenLabs error: ' + ttsRes.status }); return; }

      const buffer = Buffer.from(await ttsRes.arrayBuffer());
      writeFileSync(audioPath, buffer);
      res.json({ ok: true, url: `/api/voice/audio/${hash}`, hash });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  router.get('/voice/audio/:hash', (req, res) => {
    const hash = req.params.hash.replace(/[^a-f0-9]/g, '');
    const audioPath = path.join(voiceCacheDir, `${hash}.mp3`);
    if (!existsSync(audioPath)) { res.status(404).json({ error: 'Audio not found' }); return; }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(readFileSync(audioPath));
  });

  return router;
}
