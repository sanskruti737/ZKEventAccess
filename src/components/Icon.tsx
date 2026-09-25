import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
  readonly children?: ReactNode;
};

const Icon = ({ children, ...props }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...props}
  >
    {children}
  </svg>
);

export const WalletIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H19a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 1 4 16.5v-9Z" />
    <path d="M4 8h14.5A2.5 2.5 0 0 1 21 10.5V16h-4a2 2 0 0 1 0-4h4" />
    <path d="M16 14h.01" />
  </Icon>
);

export const ShieldCheckIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M12 3 20 6v5.2c0 4.9-3.3 8.3-8 9.8-4.7-1.5-8-4.9-8-9.8V6l8-3Z" />
    <path d="m8.5 12 2.2 2.2 4.8-5" />
  </Icon>
);

export const LockIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" />
  </Icon>
);

export const PlusIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ScanIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M8 20H5a1 1 0 0 1-1-1v-3M16 20h3a1 1 0 0 0 1-1v-3" />
    <path d="M7 12h10" />
  </Icon>
);

export const SparklesIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m12 3-1.2 4.8L6 9l4.8 1.2L12 15l1.2-4.8L18 9l-4.8-1.2L12 3Z" />
    <path d="m19 14-.7 2.3L16 17l2.3.7L19 20l.7-2.3L22 17l-2.3-.7L19 14ZM5 14l-.5 1.5L3 16l1.5.5L5 18l.5-1.5L7 16l-1.5-.5L5 14Z" />
  </Icon>
);

export const ActivityIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M3 12h4l2-7 4 14 2-7h6" />
  </Icon>
);

export const CopyIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <rect x="8" y="8" width="11" height="11" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Icon>
);

export const CheckIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m5 12 4.2 4.2L19 6.5" />
  </Icon>
);

export const AlertIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M12 4 21 20H3L12 4Z" />
    <path d="M12 9v5M12 17h.01" />
  </Icon>
);

export const LoaderIcon = ({ className, ...props }: SVGProps<SVGSVGElement>) => (
  <Icon {...props} className={`zk-loader ${className ?? ''}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </Icon>
);

export const ExternalLinkIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M14 5h5v5M19 5l-8 8" />
    <path d="M18 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
);

export const ChevronRightIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
);

export const KeyIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <circle cx="8.5" cy="15.5" r="3.5" />
    <path d="m11 13 7-7M15 6l3 3M17 4l3 3" />
  </Icon>
);

export const GlobeIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.1-3.3-8.5S9.8 5.8 12 3.5Z" />
  </Icon>
);

export const RefreshIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14m0 5v-5h-5" />
  </Icon>
);
