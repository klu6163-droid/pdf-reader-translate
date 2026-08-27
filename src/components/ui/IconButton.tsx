import type { ButtonHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export default function IconButton({
  label,
  icon,
  size = 'md',
  className,
  title,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={clsx(
        'icon-button',
        size === 'sm' && 'icon-button-sm',
        size === 'lg' && 'icon-button-lg',
        className,
      )}
      {...props}
    >
      {icon}
    </button>
  );
}
