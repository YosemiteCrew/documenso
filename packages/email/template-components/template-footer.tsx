import { Trans } from '@lingui/react/macro';
import { Fragment } from 'react';

import { Link, Section, Text } from '../components';
import { useBranding } from '../providers/branding';
import { getSafeBrandingUrl } from '../utils/branding-url';

export type TemplateFooterProps = {
  isDocument?: boolean;
  reportUrl?: string;
};

export const TemplateFooter = ({ isDocument = true, reportUrl }: TemplateFooterProps) => {
  const branding = useBranding();

  const safeBrandingUrl = branding.brandingEnabled ? getSafeBrandingUrl(branding.brandingUrl) : null;

  return (
    <Section>
      {reportUrl && (
        <Text className="my-4 text-base text-muted-foreground">
          <Trans>
            Did not expect this email?{' '}
            <Link className="text-primary" href={reportUrl}>
              Click here to report the sender
            </Link>
            . Never sign a document you don't recognize or weren't expecting.
          </Trans>
        </Text>
      )}

      {isDocument && !branding.brandingHidePoweredBy && (
        <Text className="my-4 text-base text-muted-foreground">
          <Trans>
            This document was sent using{' '}
            <Link className="text-[#247AED]" href="/">
              Yosemite Crew
            </Link>
            .
          </Trans>
        </Text>
      )}

      {branding.brandingEnabled && branding.brandingCompanyDetails && (
        <Text className="my-8 text-muted-foreground text-sm">
          {branding.brandingCompanyDetails.split('\n').map((line, idx) => {
            return (
              <Fragment key={idx}>
                {idx > 0 && <br />}
                {line}
              </Fragment>
            );
          })}
        </Text>
      )}

      {branding.brandingEnabled && safeBrandingUrl && (
        <Text className="my-8 text-muted-foreground text-sm">
          <Link href={safeBrandingUrl} target="_blank">
            {safeBrandingUrl}
          </Link>
        </Text>
      )}

      {!branding.brandingEnabled && (
        <Text className="my-8 text-sm text-slate-400">
          © {new Date().getFullYear()} DuneXploration
          <br />
          DuneXploration UG (haftungsbeschränkt), Am Finther Weg 7, 55127 Mainz
          <br />
          Email: support@yosemitecrew.com | Phone: +49 152 277 63275
          <br />
          Geschäftsführer: Ankit Upadhyay | Amtsgericht Mainz unter HRB 52778 | VAT: DE367920596
        </Text>
      )}
    </Section>
  );
};

export default TemplateFooter;
