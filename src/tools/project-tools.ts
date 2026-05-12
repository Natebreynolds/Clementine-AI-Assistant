/**
 * Clementine TypeScript — Project MCP tools (1.18.187).
 *
 * project_discover — find filesystem candidates for a project the user
 *                    mentioned but hasn't linked yet
 * project_link     — register a folder as a Clementine project
 * project_deploy   — run the active project's declared deploy and
 *                    verify by curling its verifyUrl
 *
 * Why these tools exist
 * ─────────────────────
 * Until 1.18.187 the chat path had no way to start a new project. The
 * only project-linking entrypoint was a Discord slash command most
 * owners didn't know about, so when the owner said "the coaches
 * project, build me an HTML report," Clementine had nothing to anchor
 * to and (as the 2026-05-11 audit found) hallucinated a deploy URL
 * from memory.
 *
 * These three tools give the chat agent a complete project flow:
 *   1. owner mentions a project not in the registry
 *   2. resolver returns null → agent calls `project_discover`
 *   3. agent surfaces candidates to owner, gets confirmation
 *   4. agent calls `project_link` to register
 *   5. subsequent turn resolves the project automatically (Part A)
 *   6. cwd shifts (Part B); sources/output convention activates (Part C)
 *   7. agent does the work and calls `project_deploy` (this tool)
 *      which runs the matching command + verifies via curl
 *
 * Each tool is read-mostly: discover does no writes; link does one
 * registry write; deploy runs an external command but always verifies
 * the result via curl before reporting success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  discoverProjectCandidates,
  DEFAULT_DISCOVERY_ROOTS,
} from '../agent/project-resolver.js';
import {
  addProject,
  getLinkedProjects,
} from '../agent/assistant.js';
import { textResult } from './shared.js';

const execAsync = promisify(exec);

// ── Deploy config types ───────────────────────────────────────────────

interface DeployConfig {
  /** Deploy backend. Only 'netlify' is supported in 1.18.187; more to come. */
  kind: 'netlify';
  /** Site identifier as the deploy CLI knows it (slug or numeric id). */
  site: string;
  /** Sub-directory of the project root to deploy. Defaults to 'output'. */
  dir?: string;
  /** Production URL to curl after deploy. Must return 2xx for success. */
  verifyUrl: string;
}

function readDeployConfig(projectPath: string): DeployConfig | null {
  const deployPath = path.join(projectPath, '.clementine', 'deploy.json');
  if (!fs.existsSync(deployPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(deployPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.kind !== 'netlify') return null;
    if (typeof parsed.site !== 'string' || !parsed.site) return null;
    if (typeof parsed.verifyUrl !== 'string' || !parsed.verifyUrl) return null;
    return parsed as DeployConfig;
  } catch {
    return null;
  }
}

// ── Tool registration ────────────────────────────────────────────────

export function registerProjectTools(server: McpServer): void {

  // ── project_discover ───────────────────────────────────────────────

  server.tool(
    'project_discover',
    "Find filesystem folders that could be a project the owner mentioned but hasn't linked yet. " +
      'Call this when the owner references "the X project" or "the X folder" and you have no matching project ' +
      'in your registry. Returns ranked candidates with content summaries — pick the best match, confirm with ' +
      'the owner, then call `project_link` to register it. Searches common locations (~/Downloads, ~/Desktop, ' +
      '~/Documents, ~/Projects).',
    {
      query: z.string().describe(
        'The project name as the owner mentioned it (e.g., "coaches", "track-coaches", "audit", "marketing-intel")',
      ),
      max_results: z.number().int().min(1).max(20).optional().describe(
        'Maximum number of candidates to return (default 5)',
      ),
    },
    async ({ query, max_results }) => {
      const candidates = discoverProjectCandidates(query, {
        maxResults: max_results ?? 5,
      });
      if (candidates.length === 0) {
        return textResult(
          `No folders matching "${query}" found in standard locations (${DEFAULT_DISCOVERY_ROOTS.map((p) => p.replace(process.env.HOME ?? '', '~')).join(', ')}).\n\n` +
            `Options:\n` +
            `1. Ask the owner for the full path to the project folder.\n` +
            `2. If this is a brand-new project, ask the owner where they'd like it created.\n` +
            `3. Try a more specific search term and call project_discover again.`,
        );
      }
      const lines = candidates.map((c, i) => {
        const score = (c.totalScore * 100).toFixed(0);
        return `${i + 1}. **${c.path}** (score ${score}/100, ${c.contentSummary})`;
      });
      return textResult(
        `Found ${candidates.length} candidate folder${candidates.length === 1 ? '' : 's'} matching "${query}":\n\n` +
          lines.join('\n') +
          `\n\nNext: confirm with the owner which one is the right project, then call project_link with the chosen path. ` +
          `If the top match has score ≥ 80 and the owner's request is unambiguous, you can link it directly without asking — ` +
          `but tell them WHICH one you linked.`,
      );
    },
  );

  // ── project_link ───────────────────────────────────────────────────

  server.tool(
    'project_link',
    'Register a folder as a Clementine project. After linking, the project becomes auto-resolvable in future chat ' +
      'turns: when the owner says "the X project", file ops shift to its folder, and the sources/output/deploy ' +
      'convention activates. Use this AFTER `project_discover` and AFTER confirming the path with the owner.',
    {
      path: z.string().describe('Absolute path to the project folder. Must exist.'),
      name: z.string().optional().describe(
        'Display name (defaults to the folder basename). Used in conversation.',
      ),
      description: z.string().optional().describe(
        'One-line description of what the project is for. Helps future recall.',
      ),
      keywords: z.array(z.string()).optional().describe(
        'Words the owner might use to reference this project. Auto-includes the folder basename. ' +
          'Example: ["coaches", "track-coaches", "recruiting"]',
      ),
    },
    async ({ path: projectPath, name, description, keywords }) => {
      const resolved = path.resolve(projectPath);
      if (!fs.existsSync(resolved)) {
        return textResult(`Cannot link: ${resolved} does not exist. Verify the path with the owner.`);
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return textResult(`Cannot link: ${resolved} is not a directory.`);
      }
      // Check duplicates.
      const existing = getLinkedProjects().find(
        (p) => path.resolve(p.path) === resolved,
      );
      if (existing) {
        return textResult(`Already linked: ${resolved}${existing.description ? ` (${existing.description})` : ''}`);
      }
      // Combine basename + any user-supplied keywords.
      const basename = path.basename(resolved);
      const finalKeywords = Array.from(new Set([
        basename.toLowerCase(),
        ...(keywords ?? []).map((k) => String(k).toLowerCase().trim()).filter(Boolean),
      ]));
      addProject(resolved, description, finalKeywords);

      // Scaffold .clementine/STATUS.md so future turns have something to read.
      try {
        const clementineDir = path.join(resolved, '.clementine');
        if (!fs.existsSync(clementineDir)) {
          fs.mkdirSync(clementineDir, { recursive: true });
        }
        const statusPath = path.join(clementineDir, 'STATUS.md');
        if (!fs.existsSync(statusPath)) {
          const stamp = new Date().toISOString();
          fs.writeFileSync(
            statusPath,
            `# ${name ?? basename} — STATUS\n\n` +
              `Linked to Clementine on ${stamp.slice(0, 10)} via chat command.\n\n` +
              (description ? `**Description**: ${description}\n\n` : '') +
              `**Keywords**: ${finalKeywords.join(', ')}\n\n` +
              `## Recent work\n\n_(this section gets appended to as Clementine does work on the project)_\n`,
          );
        }
      } catch { /* scaffolding is best-effort; link succeeds either way */ }

      return textResult(
        `Linked ${resolved} as a project (keywords: ${finalKeywords.join(', ')}). ` +
          `Future turns mentioning any of those keywords will auto-shift cwd here. ` +
          `Scaffold created at ${resolved}/.clementine/STATUS.md.`,
      );
    },
  );

  // ── project_deploy ─────────────────────────────────────────────────

  server.tool(
    'project_deploy',
    'Deploy the active project using its declared `.clementine/deploy.json` config and verify the live URL ' +
      'returns 2xx before reporting success. Use this instead of inventing your own netlify/vercel commands — ' +
      'it guarantees the deploy actually landed by curling the result. Only works when a project is active and ' +
      'has `.clementine/deploy.json` set up.',
    {
      project_path: z.string().describe(
        'Absolute path to the project to deploy. Must have .clementine/deploy.json.',
      ),
      dry_run: z.boolean().optional().describe(
        'If true, show what command WOULD run without executing. Default false.',
      ),
    },
    async ({ project_path, dry_run }) => {
      const resolved = path.resolve(project_path);
      if (!fs.existsSync(resolved)) {
        return textResult(`Cannot deploy: ${resolved} does not exist.`);
      }
      const config = readDeployConfig(resolved);
      if (!config) {
        return textResult(
          `Cannot deploy: ${resolved}/.clementine/deploy.json missing or invalid. Expected shape:\n` +
            `{\n  "kind": "netlify",\n  "site": "your-site-slug",\n  "dir": "output",\n  "verifyUrl": "https://your-site.netlify.app/"\n}\n` +
            `Write this file first, then retry. If the owner hasn't set up a deploy target yet, ask them which Netlify site to use.`,
        );
      }
      const deployDir = path.join(resolved, config.dir ?? 'output');
      if (!fs.existsSync(deployDir)) {
        return textResult(`Cannot deploy: ${deployDir} does not exist. Build the artifact first.`);
      }
      const cmd = `netlify deploy --prod --dir "${deployDir}" --site "${config.site}"`;
      if (dry_run) {
        return textResult(`[DRY RUN] Would execute: ${cmd}\nThen curl ${config.verifyUrl} to verify HTTP 2xx.`);
      }
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: resolved,
          maxBuffer: 4 * 1024 * 1024,
          timeout: 300_000, // 5 min cap
        });
        const cmdOutput = `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(-2000);
        // Verify by curling the live URL.
        const verifyOutput = await verifyDeployUrl(config.verifyUrl);
        if (!verifyOutput.ok) {
          return textResult(
            `Deploy command completed but verification FAILED:\n` +
              `URL: ${config.verifyUrl}\n` +
              `Status: ${verifyOutput.status ?? 'unreachable'}\n\n` +
              `Deploy command output:\n${cmdOutput}\n\n` +
              `Tell the owner: deploy ran but the live URL is not returning a success status. Do NOT claim success.`,
          );
        }
        return textResult(
          `Deploy verified ✓\n` +
            `URL: ${config.verifyUrl} → HTTP ${verifyOutput.status}\n\n` +
            `Deploy command output:\n${cmdOutput}`,
        );
      } catch (err) {
        return textResult(
          `Deploy command FAILED:\n${String(err)}\n\n` +
            `Common causes: netlify CLI not logged in (run \`netlify login\`), site slug wrong, ` +
            `or the deploy dir is empty/missing. Tell the owner the deploy did not succeed.`,
        );
      }
    },
  );
}

async function verifyDeployUrl(url: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const { stdout } = await execAsync(`curl -sIL --max-time 15 "${url}"`, {
      maxBuffer: 256 * 1024,
      timeout: 20_000,
    });
    // Parse the LAST HTTP/N status line (after any redirects).
    const lines = stdout.split('\n').filter((l) => /^HTTP\//i.test(l));
    if (lines.length === 0) return { ok: false };
    const lastLine = lines[lines.length - 1]!;
    const match = lastLine.match(/HTTP\/[\d.]+\s+(\d{3})/);
    if (!match) return { ok: false };
    const status = parseInt(match[1]!, 10);
    return { ok: status >= 200 && status < 300, status };
  } catch {
    return { ok: false };
  }
}
