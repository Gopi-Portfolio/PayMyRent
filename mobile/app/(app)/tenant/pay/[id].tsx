// The pay screen: the same flow as the Pay sheet on the home page (see PayFlow), for deep links and the pay-many screen.
import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { PayFlow } from '@/components/PayFlow';
import { Screen } from '@/components/ui';

export default function Pay() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Screen><PayFlow id={String(id)} /></Screen>;
}
