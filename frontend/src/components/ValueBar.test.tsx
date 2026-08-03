import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DealStatus } from '@/lib/types';

import { ValueBar } from './ValueBar';

const XLM = 10_000_000n;

function widths(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[style*="width"]')).map(
    (element) => element.style.width,
  );
}

/** Milestone boundaries are the only positioned spans; legend swatches have no style. */
function dividers(container: HTMLElement): NodeListOf<HTMLElement> {
  return container.querySelectorAll<HTMLElement>('span[aria-hidden][style]');
}

function renderBar(props: {
  total: bigint;
  released: bigint;
  milestoneCount: number;
  status: DealStatus;
}) {
  return render(<ValueBar {...props} showLegend />);
}

describe('ValueBar', () => {
  it('describes the deal for screen readers in real amounts', () => {
    renderBar({ total: 30n * XLM, released: 15n * XLM, milestoneCount: 2, status: 'active' });

    expect(
      screen.getByRole('img', {
        name: '15 XLM released of 30 XLM across 2 milestones',
      }),
    ).toBeInTheDocument();
  });

  it('splits the bar between released and held', () => {
    const { container } = renderBar({
      total: 30n * XLM,
      released: 10n * XLM,
      milestoneCount: 3,
      status: 'active',
    });

    // A third paid, two thirds still locked.
    expect(widths(container)).toContain('33.33%');
    expect(widths(container)).toContain('66.67%');
  });

  /** Nothing is held before the client funds it — only the schedule exists. */
  it('shows no held segment on an unfunded deal', () => {
    const { container } = renderBar({
      total: 30n * XLM,
      released: 0n,
      milestoneCount: 3,
      status: 'pending',
    });

    expect(widths(container)).toEqual(['0%']);
    expect(screen.getByText(/to be funded/)).toBeInTheDocument();
  });

  it('fills completely once every milestone is paid', () => {
    const { container } = renderBar({
      total: 30n * XLM,
      released: 30n * XLM,
      milestoneCount: 2,
      status: 'completed',
    });

    expect(widths(container)).toContain('100%');
    expect(screen.getByText('released')).toBeInTheDocument();
    expect(screen.queryByText('held in escrow')).not.toBeInTheDocument();
  });

  it('reports a refund as returned to the client, not as held', () => {
    renderBar({ total: 30n * XLM, released: 10n * XLM, milestoneCount: 3, status: 'refunded' });

    expect(screen.getByText('returned to client')).toBeInTheDocument();
    expect(screen.queryByText('held in escrow')).not.toBeInTheDocument();
  });

  it('draws one divider fewer than there are milestones', () => {
    const { container } = renderBar({
      total: 30n * XLM,
      released: 0n,
      milestoneCount: 4,
      status: 'active',
    });

    expect(dividers(container)).toHaveLength(3);
  });

  it('draws no dividers for a single-milestone deal', () => {
    const { container } = renderBar({
      total: 30n * XLM,
      released: 0n,
      milestoneCount: 1,
      status: 'active',
    });

    expect(dividers(container)).toHaveLength(0);
  });

  it('survives a zero-value deal without dividing by it', () => {
    const { container } = renderBar({
      total: 0n,
      released: 0n,
      milestoneCount: 1,
      status: 'pending',
    });

    expect(widths(container)).toEqual(['0%']);
  });
});
