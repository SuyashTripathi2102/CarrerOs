import '@testing-library/jest-dom';

/**
 * next/link needs a mounted App Router to navigate. In tests a link is a plain
 * anchor: its href and onClick are what the page controls, and a click must
 * not try to navigate the test document.
 */
jest.mock('next/link', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const Link = ({
    href,
    children,
    onClick,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement(
      'a',
      {
        ...rest,
        href,
        onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          onClick?.(e);
        },
      },
      children,
    );
  return { __esModule: true, default: Link };
});
