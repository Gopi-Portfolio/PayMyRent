import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { FormatSelect } from '@/components/FormatSelect';
import { downloadReport } from '@/lib/download';
import '@/i18n';

jest.mock('@/lib/download', () => ({ downloadReport: jest.fn(async () => undefined) }));

test('the list is closed until opened, offers CSV and PDF only, and a tap downloads that format', async () => {
  const { getByTestId, queryByTestId } = render(<FormatSelect label="Download My Data" path="/api/v1/me/export" fileName="paymyrent-my-data" />);
  expect(queryByTestId('format-csv')).toBeNull();
  fireEvent.press(getByTestId('format-dropdown'));
  expect(queryByTestId('format-csv')).not.toBeNull();
  expect(queryByTestId('format-pdf')).not.toBeNull();
  expect(queryByTestId('format-json')).toBeNull();
  fireEvent.press(getByTestId('format-pdf'));
  await waitFor(() => expect(downloadReport).toHaveBeenCalledWith('/api/v1/me/export', 'pdf', 'paymyrent-my-data'));
  expect(queryByTestId('format-csv')).toBeNull();            // closes after choosing
});
