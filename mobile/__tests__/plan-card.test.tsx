import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { PricingCards } from '@/components/ui';
import { api } from '@/lib/api';
import '@/i18n';

jest.mock('@/lib/api', () => ({ api: jest.fn() }));
const PLANS = [
  { code: 'starter', label: 'Starter', price_paise: 5000, price_display: '₹50', max_units: 10, max_properties: 1, ai_enabled: false, ai_monthly_tokens: 0 },
  { code: 'growth', label: 'Growth', price_paise: 10000, price_display: '₹100', max_units: 50, max_properties: 5, ai_enabled: true, ai_monthly_tokens: 100000 },
  { code: 'business', label: 'Business', price_paise: 50000, price_display: '₹500', max_units: 300, max_properties: 25, ai_enabled: true, ai_monthly_tokens: 500000 },
];
const show = (props: React.ComponentProps<typeof PricingCards> = {}) => {
  (api as jest.Mock).mockResolvedValue({ plans: PLANS });
  return render(<QueryClientProvider client={new QueryClient()}><PaperProvider><PricingCards onSelect={() => undefined} {...props} /></PaperProvider></QueryClientProvider>);
};

test('each plan shows its name, monthly price, how many units and properties it covers, and whether it has the AI assistant', async () => {
  const ui = show();
  await waitFor(() => expect(ui.getByTestId('plan-starter')).toBeTruthy());
  for (const [name, price] of [['Starter', '₹50'], ['Growth', '₹100'], ['Business', '₹500']]) {
    expect(ui.getByText(name)).toBeTruthy();
    expect(ui.getByText(new RegExp('^' + price + '(?!\\d)'))).toBeTruthy();
  }
  expect(ui.getByText('Up to 10 units')).toBeTruthy();
  expect(ui.getByText('1 property')).toBeTruthy();
  expect(ui.getByText('Up to 50 units')).toBeTruthy();
  expect(ui.getByText('Up to 5 properties')).toBeTruthy();
  expect(ui.getByText('Up to 300 units')).toBeTruthy();
  expect(ui.getByText('Up to 25 properties')).toBeTruthy();
  expect(ui.getAllByText('AI assistant').length).toBe(2);                 // Growth and Business; Starter has none
  expect(ui.getAllByText('Monthly bills made for every unit').length).toBe(3);
});

test('Growth is marked Most Popular, and a free first month is shown on every plan when the number is eligible', async () => {
  const ui = show({ freeMonth: true });
  await waitFor(() => expect(ui.getByTestId('plan-growth')).toBeTruthy());
  expect(ui.getAllByText('Most Popular').length).toBe(1);
  for (const code of ['starter', 'growth', 'business']) expect(ui.getByTestId(`free-${code}`)).toBeTruthy();
  const none = show();
  await waitFor(() => expect(none.getAllByTestId('plan-growth').length).toBeGreaterThan(0));
  expect(none.queryByTestId('free-growth')).toBeNull();
});

test('choosing a plan reports its code, and the selected plan says Selected', async () => {
  const onSelect = jest.fn();
  const ui = show({ onSelect, selected: 'growth' });
  await waitFor(() => expect(ui.getByTestId('choose-business')).toBeTruthy());
  expect(ui.getByText('Selected')).toBeTruthy();
  fireEvent.press(ui.getByTestId('choose-business'));
  expect(onSelect).toHaveBeenCalledWith('business');
});

test('the plan an owner already has is marked as the current plan', async () => {
  const ui = show({ currentPlan: 'starter' });
  await waitFor(() => expect(ui.getByText('Your Current Plan')).toBeTruthy());
});
