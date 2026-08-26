import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppErrorBoundary from './AppErrorBoundary';

const diagnosticsMocks = vi.hoisted(() => ({
  recordFrontendCrash: vi.fn(() => Promise.resolve('C:\\logs\\frontend-crash.log')),
  formatFrontendCrash: vi.fn(() => 'safe crash report'),
  downloadFrontendCrash: vi.fn(),
}));

vi.mock('@/services/diagnostics', () => diagnosticsMocks);

function BrokenView(): never {
  throw new Error('render exploded');
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('replaces a crashed render with a recoverable screen and persists the crash', async () => {
    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: '界面发生异常' })).toBeInTheDocument();
    await waitFor(() => expect(diagnosticsMocks.recordFrontendCrash).toHaveBeenCalledOnce());
    expect(await screen.findByText('C:\\logs\\frontend-crash.log')).toBeInTheDocument();
  });
});
