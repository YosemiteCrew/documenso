import type { HTMLAttributes } from 'react';

export type LogoProps = HTMLAttributes<HTMLDivElement> & {
  className?: string;
};

export const BrandingLogo = ({ className, ...props }: LogoProps) => {
  return (
    <div className={`flex items-center gap-2 ${className || ''}`} {...props}>
      <img
        src="/static/logo.png"
        alt="Yosemite Crew"
        className="h-8 w-8 object-contain"
      />
      <span className="font-satoshi text-lg font-medium text-text-primary">
        Yosemite Crew
      </span>
    </div>
  );
};
