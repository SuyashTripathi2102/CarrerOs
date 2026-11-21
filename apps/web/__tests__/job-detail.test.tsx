import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/lib/api';
import JobPage from '@/app/jobs/[id]/page';

jest.mock('@/lib/api');
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'job-1' }) }));
const mocked = jest.mocked(api);

const now = new Date().toISOString();
const job = {
  id: 'job-1',
  title: 'Backend Engineer',
  description: 'Build and run Node.js services.',
  url: 'https://careers.acme.example/jobs/1',
  location: 'Bengaluru',
  workMode: 'HYBRID',
  salaryMin: null,
  salaryMax: null,
  currency: null,
  postedAt: now,
  firstSeenAt: now,
  company: { name: 'Acme', website: null, careerPageUrl: null, atsProvider: 'GREENHOUSE' },
  skills: [],
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    userYears: 2,
    careerPath: null,
    whatIf: [],
    atsKeywords: null,
    company: null,
    verdict: {
      verdict: 'APPLY',
      code: null,
      reason: null,
      action: null,
      opportunityScore: 84,
      developmentConfidence: 90,
      targetRoleFit: 80,
      specializationFit: 75,
      resumeFit: 70,
      missingSkills: [],
    },
    classification: null,
    specialization: null,
    ...overrides,
  };
}

function serve(d: unknown, jobResult: unknown = job) {
  mocked.apiGet.mockImplementation((path: string) => {
    if (path === '/jobs/job-1') return jobResult instanceof Error ? Promise.reject(jobResult) : Promise.resolve(jobResult);
    if (path === '/matches/detail/job-1') return d instanceof Error ? Promise.reject(d) : Promise.resolve(d);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mocked.apiPost.mockResolvedValue(undefined);
});

describe('Job detail: deciding on one job', () => {
  it('shows the job and the verdict in plain language', async () => {
    serve(detail());
    render(<JobPage />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Backend Engineer' })).toBeInTheDocument();
    expect(screen.getByText('Acme · 📍 Bengaluru · hybrid')).toBeInTheDocument();
    expect(screen.getByText(/💰 Not listed/)).toBeInTheDocument();
    expect(screen.getByText('Apply now')).toBeInTheDocument();
    expect(screen.getByText('Apply now — your role, your stack, and it clears the bar.')).toBeInTheDocument();
    expect(screen.getByText('84')).toBeInTheDocument();
  });

  it('"I applied" records the application once, then shows it as tracked', async () => {
    const user = userEvent.setup();
    serve(detail());
    render(<JobPage />);

    await user.click(await screen.findByRole('button', { name: 'I applied' }));

    expect(mocked.apiPost).toHaveBeenCalledWith('/applications', { jobId: 'job-1' });
    const tracked = await screen.findByRole('button', { name: '✓ Tracked' });
    expect(tracked).toBeDisabled();
    await user.click(tracked);
    expect(mocked.apiPost).toHaveBeenCalledTimes(1);
  });

  it('if recording fails, the button stays available so you can try again', async () => {
    const user = userEvent.setup();
    serve(detail());
    mocked.apiPost.mockRejectedValueOnce(new Error('API 500'));
    render(<JobPage />);

    await user.click(await screen.findByRole('button', { name: 'I applied' }));
    const again = screen.getByRole('button', { name: 'I applied' });
    expect(again).toBeEnabled();

    await user.click(again);
    expect(await screen.findByRole('button', { name: '✓ Tracked' })).toBeDisabled();
    expect(mocked.apiPost).toHaveBeenCalledTimes(2);
  });

  it('links go to the employer, to tailoring for this job and to referrals for this job', async () => {
    serve(detail());
    render(<JobPage />);

    const employer = await screen.findByRole('link', { name: /Apply on company site/ });
    expect(employer).toHaveAttribute('href', job.url);
    expect(employer).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: /Tailor my resume/ })).toHaveAttribute('href', '/resumes/tailor/job-1');
    expect(screen.getByRole('link', { name: /Find a referral/ })).toHaveAttribute('href', '/referrals/job-1');
  });

  it('a career-direction answer is saved and acknowledged', async () => {
    const user = userEvent.setup();
    serve(detail({ careerPath: { discipline: 'DATA_ENGINEERING', label: 'Data Engineering', preference: null } }));
    render(<JobPage />);

    await user.click(await screen.findByRole('button', { name: 'No, never' }));

    expect(mocked.apiPost).toHaveBeenCalledWith('/matches/career-preference', {
      discipline: 'DATA_ENGINEERING',
      preference: 'NO',
    });
    expect(screen.getByText('Got it — CareerOS will stop recommending Data Engineering roles.')).toBeInTheDocument();
  });

  it('without a match decision the job still shows, with no verdict', async () => {
    serve(new Error('API 404'));
    render(<JobPage />);

    expect(await screen.findByRole('heading', { name: 'Backend Engineer' })).toBeInTheDocument();
    expect(screen.queryByText('Apply now')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I applied' })).toBeInTheDocument();
  });

  it('shows the error when the job cannot be loaded', async () => {
    serve(detail(), new Error('API 404'));
    render(<JobPage />);

    expect(await screen.findByText('Error: API 404')).toBeInTheDocument();
  });
});
