import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/lib/api';
import Resumes from '@/app/resumes/page';

jest.mock('@/lib/api');
const mocked = jest.mocked(api);

const primary = {
  id: 'r1',
  title: 'Node.js Backend',
  isPrimary: true,
  versions: [
    { id: 'v2', createdAt: '2026-11-20T10:00:00.000Z', activatedAt: null, atsScore: 100, atsVerdict: 'SAFE' },
    { id: 'v1', createdAt: '2026-08-12T10:00:00.000Z', activatedAt: '2026-08-12T10:05:00.000Z', atsScore: 50, atsVerdict: 'RISKY' },
  ],
};

const safeReport = {
  score: 100,
  verdict: 'SAFE',
  letterRatio: 0.92,
  checks: [{ id: 'text', label: 'Text layer present', pass: true, detail: '3,200 characters' }],
};

const pdf = () => new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

beforeEach(() => {
  jest.resetAllMocks();
});

describe('Resumes: versions and the ATS check', () => {
  it('lists every version and shows which one drives your recommendations', async () => {
    mocked.apiGet.mockResolvedValue([primary]);
    render(<Resumes />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('ACTIVE — drives your recommendations')).toBeInTheDocument();
    expect(screen.getByText('inactive — history kept, not matching')).toBeInTheDocument();
    expect(screen.getByText('ATS 100/100 SAFE')).toBeInTheDocument();
    expect(screen.getByText('ATS 50/100 RISKY')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review & activate' })).toHaveAttribute('href', '/resumes/v2');
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/resumes/v1');
  });

  it('with no resume yet, says so', async () => {
    mocked.apiGet.mockResolvedValue([]);
    render(<Resumes />);

    expect(await screen.findByText('No resume uploaded yet.')).toBeInTheDocument();
  });

  it('uploading a PDF adds a version to the primary resume, shows the ATS check, and activates nothing', async () => {
    const user = userEvent.setup();
    mocked.apiGet.mockResolvedValue([primary]);
    let finish: (v: unknown) => void = () => {};
    mocked.apiUpload.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { container } = render(<Resumes />);
    await screen.findByText('ACTIVE — drives your recommendations');

    const file = pdf();
    await user.upload(fileInput(container), file);

    expect(screen.getByText('Checking and parsing…')).toBeInTheDocument();
    expect(mocked.apiUpload).toHaveBeenCalledWith('/resumes', file, { resumeId: 'r1' });

    finish({ ats: safeReport });
    expect(await screen.findByText('100/100')).toBeInTheDocument();
    expect(screen.getByText('Every applicant tracking system will read this correctly.')).toBeInTheDocument();
    expect(screen.getByText('Text layer present')).toBeInTheDocument();
    expect(await screen.findByText('Drop a PDF here, or click to choose')).toBeInTheDocument();
    // The list is reloaded, and nothing is activated: that only happens on the version's own page.
    expect(mocked.apiGet.mock.calls.filter(([p]) => p === '/resumes')).toHaveLength(2);
    expect(mocked.apiPost).not.toHaveBeenCalled();
    expect(mocked.apiPut).not.toHaveBeenCalled();
    expect(mocked.apiPatch).not.toHaveBeenCalled();
  });

  it('with no resume yet, the upload creates the first one', async () => {
    const user = userEvent.setup();
    mocked.apiGet.mockResolvedValue([]);
    mocked.apiUpload.mockResolvedValue({ ats: safeReport });
    const { container } = render(<Resumes />);
    await screen.findByText('No resume uploaded yet.');

    const file = pdf();
    await user.upload(fileInput(container), file);

    expect(mocked.apiUpload).toHaveBeenCalledWith('/resumes', file, {});
  });

  it('a failed upload shows why and lets you try again', async () => {
    const user = userEvent.setup();
    mocked.apiGet.mockResolvedValue([primary]);
    mocked.apiUpload.mockRejectedValue(new Error('API 413'));
    const { container } = render(<Resumes />);
    await screen.findByText('ACTIVE — drives your recommendations');

    await user.upload(fileInput(container), pdf());

    expect(await screen.findByText('API 413')).toBeInTheDocument();
    expect(screen.getByText('Drop a PDF here, or click to choose')).toBeInTheDocument();
    expect(fileInput(container)).toBeEnabled();
  });
});
