import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/lib/api';
import TodayPage from '@/app/today/page';

jest.mock('@/lib/api');
const mocked = jest.mocked(api);

type Impact = 'DO_FIRST' | 'HIGH' | 'MEDIUM' | 'LOW';
interface Action {
  kind: string;
  title: string;
  detail: string;
  chips: string[];
  impact: Impact;
  minutes: number;
  href: string;
  jobId?: string;
  opportunity?: number;
  why?: string[];
}

const apply: Action = {
  kind: 'APPLY',
  title: 'Apply: Backend Engineer at Acme',
  detail: 'Node.js, PostgreSQL',
  chips: ['Node.js'],
  impact: 'DO_FIRST',
  minutes: 20,
  href: '/jobs/job-1',
  jobId: 'job-1',
  opportunity: 82,
  why: ['Your stack, posted today'],
};
const learn: Action = {
  kind: 'LEARN',
  title: 'Learn: Docker basics',
  detail: 'Asked for in many of your matches',
  chips: [],
  impact: 'LOW',
  minutes: 15,
  href: '/learn',
};
const potential: Action = {
  kind: 'POTENTIAL',
  title: 'Look at: API Developer at Beta',
  detail: 'Not evaluated yet',
  chips: [],
  impact: 'MEDIUM',
  minutes: 5,
  href: '/jobs/job-2',
  jobId: 'job-2',
};

function plan(actions: Action[], goal = { label: 'Apply to 2 jobs', done: 0, target: 2 }) {
  return {
    greeting: 'Good morning',
    name: 'Asha Rao',
    goal,
    weekProbability: 'MEDIUM',
    probabilityReason: '3 strong matches this week',
    totalMinutes: actions.reduce((n, a) => n + a.minutes, 0),
    actions,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mocked.apiPost.mockResolvedValue(undefined);
});

describe('Today: the daily plan', () => {
  it('shows the plan: greeting by first name, the mission, and each step in order', async () => {
    mocked.apiGet.mockResolvedValue(plan([apply, learn, potential]));
    render(<TodayPage />);

    expect(screen.getByText('Planning your day…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Good morning, Asha' })).toBeInTheDocument();
    expect(mocked.apiGet).toHaveBeenCalledWith('/today');
    expect(screen.getByText('Your fastest path to an interview today')).toBeInTheDocument();
    expect(screen.getByText(/3 actions · ~40 min/)).toBeInTheDocument();
    expect(screen.getAllByText(/STEP \d OF 3/).map((n) => n.textContent)).toEqual([
      'STEP 1 OF 3',
      'STEP 2 OF 3',
      'STEP 3 OF 3',
    ]);
    expect(screen.getByText('DO THIS FIRST')).toBeInTheDocument();
    expect(screen.getByText('Your stack, posted today')).toBeInTheDocument();
  });

  it('records which jobs were shown and where, leaving out actions that are not jobs', async () => {
    mocked.apiGet.mockResolvedValue(plan([apply, learn, potential]));
    render(<TodayPage />);
    await screen.findByRole('heading', { name: 'Good morning, Asha' });

    expect(mocked.apiPost).toHaveBeenCalledWith('/events/impressions', {
      surface: 'today',
      items: [
        { jobId: 'job-1', rank: 1, displayedScore: 82, displayedVerdict: 'APPLY' },
        { jobId: 'job-2', rank: 3, displayedScore: undefined, displayedVerdict: 'POTENTIAL' },
      ],
    });
  });

  it('"Not relevant" hides a job, renumbers the steps, and logs it at its original rank', async () => {
    const user = userEvent.setup();
    mocked.apiGet.mockResolvedValue(plan([apply, learn, potential]));
    render(<TodayPage />);
    await screen.findByRole('heading', { name: 'Good morning, Asha' });

    // Only job cards can be dismissed; "Learn" is not an opportunity.
    expect(screen.getAllByRole('button', { name: /as not relevant/ })).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: `Dismiss "${apply.title}" as not relevant` }));

    expect(mocked.apiPost).toHaveBeenCalledWith('/events', {
      jobId: 'job-1',
      type: 'DISMISSED',
      surface: 'today',
      rank: 1,
      displayedScore: 82,
      displayedVerdict: 'APPLY',
    });
    expect(screen.queryByText(apply.title)).not.toBeInTheDocument();
    expect(screen.getAllByText(/STEP \d OF 2/)).toHaveLength(2);
    expect(screen.getByText(/2 actions · ~20 min/)).toBeInTheDocument();

    // The second job is now step 2 on screen, but it was shown at rank 3.
    await user.click(screen.getByRole('button', { name: `Dismiss "${potential.title}" as not relevant` }));
    expect(mocked.apiPost).toHaveBeenLastCalledWith(
      '/events',
      expect.objectContaining({ jobId: 'job-2', type: 'DISMISSED', rank: 3 }),
    );
  });

  it('opening a job card logs the click at its rank and links to the job', async () => {
    const user = userEvent.setup();
    mocked.apiGet.mockResolvedValue(plan([learn, apply]));
    render(<TodayPage />);

    const card = await screen.findByRole('link', { name: /Backend Engineer at Acme/ });
    expect(card).toHaveAttribute('href', '/jobs/job-1');
    await user.click(card);

    expect(mocked.apiPost).toHaveBeenCalledWith(
      '/events',
      expect.objectContaining({ jobId: 'job-1', type: 'CLICKED', rank: 2 }),
    );
  });

  it('with nothing queued, it says so and points to the board, logging no impressions', async () => {
    mocked.apiGet.mockResolvedValue(plan([]));
    render(<TodayPage />);

    expect(await screen.findByText('Line up your next opportunity')).toBeInTheDocument();
    expect(screen.getByText(/Nothing queued right now/)).toBeInTheDocument();
    expect(mocked.apiPost).not.toHaveBeenCalled();
  });

  it('when today\'s goal is met, it tells you you are done', async () => {
    mocked.apiGet.mockResolvedValue(plan([apply], { label: 'Apply to 2 jobs', done: 2, target: 2 }));
    render(<TodayPage />);

    expect(await screen.findByText(/Done for today/)).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  it('shows the error when the plan cannot be loaded', async () => {
    mocked.apiGet.mockRejectedValue(new Error('API 500'));
    render(<TodayPage />);

    expect(await screen.findByText('Error: API 500')).toBeInTheDocument();
  });
});
