import type { HTMLAttributes } from 'react';

export type LogoProps = HTMLAttributes<HTMLImageElement> & {
  className?: string;
};

export const BrandingLogoIcon = ({ className, ...props }: LogoProps) => {
  return (
    <img
      src="/static/logo.png"
      alt="Yosemite Crew"
      className={`h-8 w-8 object-contain ${className || ''}`}
      {...props}
    />
  );
};
