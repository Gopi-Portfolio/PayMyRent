// The logos shown on the small UPI app buttons. ONLY the brands' own official files are used, never re-drawn or altered (see assets/upi/README.md).
// While a value is null (the file has not been added yet) the button shows a neutral grey tile with the app's name.
import type { ImageSourcePropType } from 'react-native';

import { PAYTM_SVG } from './upiLogoSvgs';

export type UpiAppKey = 'gpay' | 'phonepe' | 'paytm' | 'other';

export type UpiLogo = { png: ImageSourcePropType } | { svg: string };

export const UPI_LOGOS: Record<UpiAppKey, UpiLogo | null> = {
  gpay: { png: require('../../assets/upi/gpay.png') },        // Google Pay acceptance mark, from developers.google.com/pay (unaltered)
  phonepe: { png: require('../../assets/upi/phonepe.png') },  // PhonePe app icon, from phonepe.com (unaltered)
  paytm: { svg: PAYTM_SVG },                                  // Paytm logo, from paytm.com (unaltered)
  other: null,
};

// What a button shows until its official logo file is added: a neutral grey tile with the app's name in plain text (no brand colours, no imitation).
export const UPI_PLACEHOLDER: Record<UpiAppKey, string> = {
  gpay: 'Google Pay',
  phonepe: 'PhonePe',
  paytm: 'Paytm',
  other: 'UPI',
};
