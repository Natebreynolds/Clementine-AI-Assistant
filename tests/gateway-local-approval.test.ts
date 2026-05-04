import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../src/gateway/router.js';

type GatewayWithLocalTurn = Gateway & {
  handleLocalTurn: (
    sessionKey: string,
    text: string,
    onText?: (text: string) => void | Promise<void>,
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
});
