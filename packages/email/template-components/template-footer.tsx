import { Trans } from '@lingui/react/macro';

import { Link, Section, Text } from '../components';
import { useBranding } from '../providers/branding';

export type TemplateFooterProps = {
  isDocument?: boolean;
};

export const TemplateFooter = ({ isDocument = true }: TemplateFooterProps) => {
  const branding = useBranding();

  return (
    <Section>
      {isDocument && !branding.brandingHidePoweredBy && (
        <Text className="my-4 text-base text-slate-400">
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
        <Text className="my-8 text-sm text-slate-400">
          {branding.brandingCompanyDetails.split('\n').map((line, idx) => {
            return (
              <>
                {idx > 0 && <br />}
                {line}
              </>
            );
          })}
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
