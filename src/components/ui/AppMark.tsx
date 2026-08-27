interface AppMarkProps {
  size?: 16 | 24 | 32;
  className?: string;
}

export default function AppMark({ size = 24, className = '' }: AppMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
    >
      <defs>
        <linearGradient
          id="mark-paper"
          x1="9"
          y1="7"
          x2="25"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E8ECF1" />
        </linearGradient>
        <linearGradient
          id="mark-accent"
          x1="12"
          y1="9"
          x2="27"
          y2="27"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#78C7FF" />
          <stop offset="0.58" stopColor="#4D8EF7" />
          <stop offset="1" stopColor="#7AE4D4" />
        </linearGradient>
      </defs>
      <rect
        x="4.75"
        y="4.25"
        width="16.5"
        height="21"
        rx="5"
        fill="#DDE3EA"
        stroke="rgba(255,255,255,.92)"
        strokeWidth="1.25"
      />
      <rect
        x="9.75"
        y="6.75"
        width="17.5"
        height="21.5"
        rx="5.25"
        fill="url(#mark-paper)"
        stroke="rgba(255,255,255,.96)"
        strokeWidth="1.3"
      />
      <path
        d="M14.25 12.5h8.5M14.25 16.35h6.25M17.25 20.2h5.75M14.25 24h8.5"
        stroke="#A4ADB9"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
      <path d="M7.75 9h6.75" stroke="#B8C0CA" strokeWidth="1.35" strokeLinecap="round" />
      <path
        d="M22 7.5c2.55.55 4.15 2.1 4.7 4.65l-3.65.15A1.2 1.2 0 0 1 21.8 11l.2-3.5Z"
        fill="url(#mark-accent)"
      />
      <path
        d="M13.9 12.45h7.9"
        stroke="url(#mark-accent)"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
    </svg>
  );
}
