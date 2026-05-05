import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../src/gateway/router.js';

type GatewayWithLocalTurn = Gateway & {
  handleLocalTurn: (
    sessionKey: string,
    text: string,
    onText?: (text: string) => void | Promise<void>,
    activeContext?: any,
  ) => Promise<string | null>;
};

function makeGateway(hasPrompt: boolean): GatewayWithLocalTurn {
  const gateway = Object.create(Gateway.prototype) as Gateway & {
    assistant: { hasRecentApprovalPrompt: () => boolean };
    approvalResolvers: Map<string, (result: boolean | string) => void>;
  };
  gateway.assistant = { hasRecentApprovalPrompt: () => hasPrompt };
  gateway.approvalResolvers = new Map();
  return gateway as unknown as GatewayWithLocalTurn;
}

describe('gateway local approval replies', () => {
  it('lets approval-shaped replies reach the SDK after a model confirmation prompt', async () => {
    const gateway = makeGateway(true);
    const onText = vi.fn();

    await expect(gateway.handleLocalTurn('discord:user:123', 'Perfect', onText)).resolves.toBeNull();
    expect(onText).not.toHaveBeenCalled();

    await expect(gateway.handleLocalTurn('discord:user:123', 'Okay', onText)).resolves.toBeNull();
    expect(onText).not.toHaveBeenCalled();
  });

  it('keeps approval-shaped replies as local acknowledgments without approval context', async () => {
    const gateway = makeGateway(false);

    await expect(gateway.handleLocalTurn('discord:user:123', 'Perfect')).resolves.toBe('Got it.');
  });

  it('answers agent-member background status check-ins locally', async () => {
    const gateway = makeGateway(false) as any;
    gateway.sessions = new Map();
    gateway.describeSessionStatus = vi.fn(() => 'status ok');

    await expect(gateway.handleLocalTurn('discord:member-dm:badando:user-1', "How's it coming along?"))
      .resolves.toBe('status ok');
    expect(gateway.describeSessionStatus).toHaveBeenCalledWith('discord:member-dm:badando:user-1');
  });

  it('routes cancel replies through background cancellation before stopping chat', async () => {
    const gateway = makeGateway(false) as any;
    gateway.cancelActiveBackgroundTask = vi.fn(() => 'Cancelled background task bg-test.');
    gateway.stopSession = vi.fn(() => false);

    await expect(gateway.handleLocalTurn('discord:member-dm:badando:user-1', 'cancel'))
      .resolves.toBe('Cancelled background task bg-test.');
    expect(gateway.cancelActiveBackgroundTask).toHaveBeenCalledWith('discord:member-dm:badando:user-1', 'cancel');
  });

  it('keeps standalone greetings lightweight even when active context exists', async () => {
    const gateway = makeGateway(false);

    await expect(gateway.handleLocalTurn(
      'discord:user:123',
      'hey',
      undefined,
      { greetingLine: 'Hey. Main thing right now: audit-inbox-check error — phase 3 failed.' },
    )).resolves.toBe('Hey. I am here.');
  });
});
