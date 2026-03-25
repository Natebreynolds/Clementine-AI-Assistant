/**
 * Clementine TypeScript — Cloudflare Tunnel Manager.
 *
 * Manages a cloudflared quick tunnel to expose the dashboard remotely.
 * No Cloudflare account required — uses free quick tunnels that generate
 * a random *.trycloudflare.com URL.
 *
 * Security: The tunnel only points at localhost. Combined with the
 * dashboard's session-cookie auth, remote users must know the access
 * token before they can see anything.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import pino from 'pino';

const logger = pino({ name: 'clementine.tunnel' });

export class TunnelManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private _url: string | null = null;
  private port: number;
  private restartCount = 0;
  private maxRestarts = 3;
  private stopping = false;

  constructor(port: number) {
    super();
    this.port = port;
  }

  /** Check if cloudflared is installed. */
  static isInstalled(): boolean {
    try {
      execSync('which cloudflared', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /** Get install instructions for the current platform. */
  static getInstallInstructions(): string {
    if (process.platform === 'darwin') {
      return 'brew install cloudflared';
    }
    return 'See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
  }

  /** Start the tunnel. Resolves with the public URL. */
  async start(): Promise<string> {
    if (this.process) {
      throw new Error('Tunnel is already running');
    }
    if (!TunnelManager.isInstalled()) {
      throw new Error(
        `cloudflared is not installed. Install with: ${TunnelManager.getInstallInstructions()}`,
      );
    }

    this.stopping = false;
    this.restartCount = 0;
    return this._spawn();
  }

  private _spawn(): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${this.port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.process = proc;
      let resolved = false;
      const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        const match = text.match(urlPattern);
        if (match && !resolved) {
          resolved = true;
          this._url = match[0];
          logger.info({ url: this._url }, 'Tunnel established');
          this.emit('url', this._url);
          resolve(this._url);
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('close', (code) => {
        this.process = null;
        const oldUrl = this._url;
        this._url = null;

        if (!resolved) {
          reject(new Error(`cloudflared exited (code ${code}) before establishing tunnel`));
          return;
        }

        if (!this.stopping && this.restartCount < this.maxRestarts) {
          this.restartCount++;
          logger.warn({ attempt: this.restartCount }, 'Tunnel closed — restarting');
          setTimeout(() => {
            if (!this.stopping) {
              this._spawn().catch((err) => {
                logger.error({ err }, 'Tunnel restart failed');
                this.emit('error', err);
              });
            }
          }, 5_000);
        } else if (!this.stopping) {
          logger.error('Tunnel closed — max restarts exceeded');
          this.emit('error', new Error('Max tunnel restarts exceeded'));
        }

        this.emit('close', oldUrl);
      });

      proc.on('error', (err) => {
        this.process = null;
        if (!resolved) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      // Timeout: if no URL after 30s, fail
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill();
          reject(new Error('Tunnel startup timed out (30s)'));
        }
      }, 30_000);
    });
  }

  /** Stop the tunnel gracefully. */
  stop(): void {
    this.stopping = true;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this._url = null;
      logger.info('Tunnel stopped');
    }
  }

  /** Get the current public URL (null if not running). */
  getUrl(): string | null {
    return this._url;
  }

  /** Whether the tunnel process is alive. */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
