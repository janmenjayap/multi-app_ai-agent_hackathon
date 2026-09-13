import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { BootstrapScreen } from '../../src/web/main.js';

afterEach(cleanup);

describe('browser bootstrap', () => {
  it('renders the application scaffold and same-origin health link', () => {
    render(<BootstrapScreen />);

    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'PromiseGuard', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('Application scaffold')).toBeVisible();
    expect(screen.getByText('No workflows have been run.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'View server health' })).toHaveAttribute(
      'href',
      '/api/health',
    );
  });

  it('has no automated component accessibility violations', async () => {
    const { container } = render(<BootstrapScreen />);

    const results = await axe.run(container, {
      // jsdom does not perform layout; the real-browser smoke checks contrast.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations).toEqual([]);
  });
});
