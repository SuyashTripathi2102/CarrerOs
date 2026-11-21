import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/lib/api';
import ApplicationsPage from '@/app/applications/page';

jest.mock('@/lib/api');
const mocked = jest.mocked(api);

type Status = 'SAVED' | 'APPLIED' | 'OA' | 'INTERVIEW' | 'OFFER' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN';

const row = (id: string, status: Status) => ({
  id,
  status,
  appliedAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z',
  job: { title: `Role ${id}`, url: `https://jobs.example/${id}`, location: 'Pune', company: { name: `Company ${id}` } },
  events: [],
});

const stats = { byStatus: {}, applied: 3, interviews: 1, offers: 0, interviewRate: null as number | null };

const intel = {
  funnel: stats,
  insights: ['Tailored applications get more replies'],
  items: [
    {
      applicationId: 'a1',
      jobId: 'j1',
      status: 'APPLIED',
      hadReferralContact: true,
      tailoredResume: false,
      waitingActions: [{ label: 'Ask for a referral', detail: 'warm intros convert', stars: 4 }],
      likelyCauses: [],
    },
  ],
};

function serve(rows: ReturnType<typeof row>[], s = stats) {
  mocked.apiGet.mockImplementation((path: string) => {
    if (path === '/applications') return Promise.resolve(rows);
    if (path === '/applications/stats') return Promise.resolve(s);
    if (path === '/applications/intelligence') return Promise.resolve(intel);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('Applications: tracking what you applied to', () => {
  it('shows the numbers that matter, and says when there is too little data for a rate', async () => {
    serve([row('a1', 'APPLIED')]);
    render(<ApplicationsPage />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('Role a1')).toBeInTheDocument();
    // "Applied" is also a stage name on each card, so read the stats panel itself.
    const statsPanel = screen.getByText('Interview rate').closest('section') as HTMLElement;
    expect(within(statsPanel).getByText('Applied').previousSibling).toHaveTextContent('3');
    expect(within(statsPanel).getByText('Interviews').previousSibling).toHaveTextContent('1');
    expect(within(statsPanel).getByText('—')).toBeInTheDocument();
    expect(within(statsPanel).getByText('needs 5+ applications')).toBeInTheDocument();
    expect(screen.getByText(/Tailored applications get more replies/)).toBeInTheDocument();
  });

  it('shows the interview rate once there is one', async () => {
    serve([row('a1', 'INTERVIEW')], { ...stats, interviewRate: 20 });
    render(<ApplicationsPage />);

    expect(await screen.findByText('20%')).toBeInTheDocument();
    expect(screen.queryByText('needs 5+ applications')).not.toBeInTheDocument();
  });

  it('with nothing tracked, explains how an application gets recorded', async () => {
    serve([]);
    render(<ApplicationsPage />);

    expect(await screen.findByText(/No applications tracked yet/)).toBeInTheDocument();
  });

  it('keeps live applications on top and puts finished ones under "Closed"', async () => {
    serve([row('a1', 'APPLIED'), row('a2', 'REJECTED')]);
    render(<ApplicationsPage />);

    await screen.findByText('Role a1');
    const closedHeading = screen.getByRole('heading', { name: 'Closed' });
    const closed = closedHeading.parentElement as HTMLElement;
    expect(within(closed).getByText('Role a2')).toBeInTheDocument();
    expect(within(closed).getByText('✕ Rejected')).toBeInTheDocument();
    expect(within(closed).queryByText('Role a1')).not.toBeInTheDocument();
  });

  it('changing an application\'s status saves it and reloads the list', async () => {
    const user = userEvent.setup();
    serve([row('a1', 'APPLIED')]);
    mocked.apiPatch.mockResolvedValue(undefined);
    render(<ApplicationsPage />);
    await screen.findByText('Role a1');

    serve([row('a1', 'INTERVIEW')]);
    await user.selectOptions(screen.getByRole('combobox'), 'INTERVIEW');

    expect(mocked.apiPatch).toHaveBeenCalledWith('/applications/a1', { status: 'INTERVIEW' });
    expect(await screen.findByDisplayValue('INTERVIEW')).toBeInTheDocument();
    expect(mocked.apiGet.mock.calls.filter(([p]) => p === '/applications')).toHaveLength(2);
  });

  it('shows whether you had a referral and a tailored resume, and the best next move', async () => {
    serve([row('a1', 'APPLIED')]);
    render(<ApplicationsPage />);

    expect(await screen.findByText('✓ referral')).toBeInTheDocument();
    expect(screen.getByText('✗ generic resume')).toBeInTheDocument();
    expect(screen.getByText('Ask for a referral')).toBeInTheDocument();
  });

  it('shows the error when applications cannot be loaded', async () => {
    mocked.apiGet.mockRejectedValue(new Error('API 500'));
    render(<ApplicationsPage />);

    expect(await screen.findByText('Error: API 500')).toBeInTheDocument();
  });
});
