/**
 * Clementine TypeScript — Team agent routing.
 *
 * Maps agent profiles to their team configuration (channelName, canMessage, etc.).
 * Bot-based agents manage their own Discord channels via AgentBotClient/BotManager.
 */

import pino from 'pino';
import type { AgentProfile } from '../types.js';
import type { AgentManager } from './agent-manager.js';
import { TEAM_COMMS_CHANNEL } from '../config.js';

const logger = pino({ name: 'clementine.team-router' });

export class TeamRouter {
  private profileManager: AgentManager;
  private commsChannelId?: string;

  constructor(profileManager: AgentManager) {
    this.profileManager = profileManager;
    this.commsChannelId = TEAM_COMMS_CHANNEL || undefined;
  }

  /** Get the resolved comms channel ID (from config). */
  getCommsChannelId(): string | undefined {
    return this.commsChannelId;
  }

  /** List all team agents (profiles with channelName set). */
  listTeamAgents(): AgentProfile[] {
    return this.profileManager.listAll().filter(
      (p) => p.team?.channelName,
    );
  }

  /** Get the communication graph (who can message whom). */
  getTopology(): { nodes: AgentProfile[]; edges: Array<{ from: string; to: string }> } {
    const agents = this.listTeamAgents();
    const edges: Array<{ from: string; to: string }> = [];

    for (const agent of agents) {
      if (!agent.team?.canMessage) continue;
      for (const target of agent.team.canMessage) {
        edges.push({ from: agent.slug, to: target });
      }
    }

    return { nodes: agents, edges };
  }
}
