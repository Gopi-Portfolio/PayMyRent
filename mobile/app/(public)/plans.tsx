// Public "Select a Plan": the plans as cards on one screen, before sign-in. Choosing one goes to the mobile number screen as an owner; the plan is
// then shown there and bought after the owner details.
import { router } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { PricingCards } from '@/components/ui';
import { markLandingSeen, setPendingPlan, setPendingRole } from '@/lib/landing';
import { brand } from '@/theme';

export default function Plans() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const choose = (code: string) => { setPendingPlan(code); setPendingRole('owner'); markLandingSeen(); router.push('/(public)/phone'); };
  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      {/* top bar: back and the page name */}
      <View style={{ paddingTop: insets.top + 8, paddingBottom: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={10} testID="plans-back"
                   style={{ position: 'absolute', left: 12, bottom: 6, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
          <Icon source="chevron-left" size={30} color={brand.green600} />
        </Pressable>
        <Text style={{ color: '#111', fontSize: 20, fontWeight: '800' }} accessibilityRole="header">{t('pricing.selectPlan')}</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 16 }} showsVerticalScrollIndicator={false}>
        <View style={{ alignItems: 'center', gap: 4, marginTop: 8 }}>
          <Icon source="crown" size={34} color={brand.green600} />
          <Text style={{ color: '#111', fontSize: 30, fontWeight: '800', textAlign: 'center' }}>
            {t('pricing.chooseTitleA')} <Text style={{ color: brand.green600, fontSize: 30, fontWeight: '800' }}>{t('pricing.chooseTitleB')}</Text>
          </Text>
          <Text style={{ color: brand.muted, fontSize: 16, textAlign: 'center' }}>{t('pricing.chooseSub')}</Text>
        </View>
        <PricingCards onSelect={choose} freeMonth />
        <Text style={{ color: brand.muted, fontSize: 13, textAlign: 'center' }}>{t('pricing.paidByOwner')}</Text>
      </ScrollView>
    </View>
  );
}
