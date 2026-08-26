import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BackendStatusBanner from './BackendStatusBanner';

describe('BackendStatusBanner diagnostics', () => {
  it('shows both log paths and allows diagnostics export while offline', () => {
    const exportDiagnostics = vi.fn();
    render(
      <BackendStatusBanner
        status="offline"
        onRecheck={vi.fn()}
        onShowHelp={vi.fn()}
        onRestart={vi.fn()}
        onExportDiagnostics={exportDiagnostics}
        failure={{
          logPath: 'C:\\logs\\backend.log',
          restartLog: 'C:\\logs\\backend-restart.log',
        }}
      />,
    );

    expect(screen.getByText(/C:\\logs\\backend\.log/)).toBeInTheDocument();
    expect(screen.getByText(/C:\\logs\\backend-restart\.log/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导出诊断' }));
    expect(exportDiagnostics).toHaveBeenCalledOnce();
  });
});
