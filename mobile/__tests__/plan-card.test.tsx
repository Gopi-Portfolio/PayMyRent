import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { PricingCards } from '@/components/ui';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn() }));
const PLANS = [
  { code: 'starter', label: 'Starter', price_paise: 100, price_display: '₹1', max_units: 10, max_properties: 1, ai_enabled: false, ai_monthly_tokens: 0 },
  { code: 'growth', label: 'Growth', price_paise: 5000, price_display: '₹50', max_units: 100, max_properties: 5, regular_price_display: '₹65', saving_percent: 23, ai_enabled: true, ai_monthly_tokens: 100000 },
  { code: 'business', label: 'Business', price_paise: 10000, price_display: '₹100', max_units: 250, max_properties: 10, regular_price_display: '₹150', saving_percent: 33, ai_enabled: true, ai_monthly_tokens: 500000 },
  { code: 'max', label: 'Max', price_paise: 100000, price_display: '₹1,000', max_units: 1000, max_properties: 100, regular_price_display: '₹2,000', saving_percent: 50, ai_enabled: true, ai_monthly_tokens: 1000000 },
];

test('each plan says how many places, for how many properties, how it is billed, and what AI it has', async () => {
  (api as jest.Mock).mockResolvedValue({ plans: PLANS });
  const ui = render(<QueryClientProvider client={new QueryClient()}><PaperProvider><PricingCards selected="starter" onSelect={() => undefined} /></PaperProvider></QueryClientProvider>);
  await waitFor(() => expect(ui.UNSAFE_getAllByType(View).some((v) => typeof v.props.onLayout === 'function')).toBe(true));
  const frame = ui.UNSAFE_getAllByType(View).find((v) => typeof v.props.onLayout === 'function')!;
  act(() => frame.props.onLayout({ nativeEvent: { layout: { width: 360, height: 800 } } }));
  await waitFor(() => expect(ui.getByText('Up to 10 places in 1 property')).toBeTruthy());
  expect(ui.getAllByText('Billed separately for each property').length).toBe(1);                          // only Starter now covers one property
  expect(ui.getByText('One price covers all 5 properties')).toBeTruthy();
  expect(ui.getByText('One price covers all 10 properties')).toBeTruthy();
  expect(ui.getByText('No AI assistant')).toBeTruthy();                                                   // ₹1 plan: no AI
  expect(ui.getByText('Up to 100 places across up to 5 properties')).toBeTruthy();
  expect(ui.getByText('AI voice and text, with findings · 1,00,000 tokens a month')).toBeTruthy();       // Growth: 1 lakh
  expect(ui.getByText('Up to 250 places across up to 10 properties')).toBeTruthy();
  expect(ui.getByText('AI voice and text, with findings · 5,00,000 tokens a month')).toBeTruthy();       // Business: 5 lakh
  expect(ui.getByText('Up to 1,000 places across up to 100 properties')).toBeTruthy();                   // Max
  expect(ui.getByText('One price covers all 100 properties')).toBeTruthy();
  expect(ui.getByText('AI voice and text, with findings · 10,00,000 tokens a month')).toBeTruthy();      // Max: 10 lakh
});


test('launch price, regular price and saving are shown clearly, from the server\'s numbers, with a note saying what they mean', async () => {
  (api as jest.Mock).mockResolvedValue({ plans: PLANS });
  const ui = render(<QueryClientProvider client={new QueryClient()}><PaperProvider><PricingCards selected="starter" onSelect={() => undefined} /></PaperProvider></QueryClientProvider>);
  await waitFor(() => expect(ui.UNSAFE_getAllByType(View).some((v) => typeof v.props.onLayout === 'function')).toBe(true));
  act(() => ui.UNSAFE_getAllByType(View).find((v) => typeof v.props.onLayout === 'function')!.props.onLayout({ nativeEvent: { layout: { width: 360, height: 800 } } }));
  await waitFor(() => expect(ui.getByTestId('launch-growth')).toBeTruthy());
  expect(ui.queryByTestId('launch-starter')).toBeNull();                                       // the Rs 1 plan has no saving to show
  for (const [code, regular, pct] of [['growth', '₹65', '23'], ['business', '₹150', '33'], ['max', '₹2,000', '50']]) {
    expect(ui.getByTestId(`launch-${code}`)).toBeTruthy();
    expect(ui.getAllByText('Launch price').length).toBe(3);
    expect(ui.getByText(`Save ${pct}%`)).toBeTruthy();
    expect(ui.getByText(regular)).toBeTruthy();                                                // the crossed-out regular price
  }
  expect(ui.getAllByText(/Regular price/).length).toBe(3);
  expect(ui.getByTestId('launch-note')).toBeTruthy();
  expect(ui.getByText(/The launch price is what you pay today/)).toBeTruthy();
  expect(ui.queryByText(/Saved \d+%/)).toBeNull();                                           // the old typed-in "Saved 50%" is gone
});
