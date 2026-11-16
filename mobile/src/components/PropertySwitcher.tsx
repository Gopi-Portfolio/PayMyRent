// The owner's properties as a dropdown: "Properties:" on the left, the choice in the box, the full list underneath when opened.
// The first row is All properties (with the count) and is the default; the others narrow every owner screen to one property.
// Each property is its own account with its own plan, so choosing one changes everything on the owner screens.
// The list opens in place (no pop-up), so every row is a plain tap. Adding a property is done from the Add Property card, not from here.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ownerAccountId, useAuth, ownerProperties } from '@/lib/auth';
import { closePropertyAsk, setViewAll, useAskingForProperty, useViewAll } from '@/lib/propertyView';
import { brand, radius } from '@/theme';

export function PropertySwitcher() {
  const { t } = useTranslation();
  const { me, selectOwner } = useAuth();
  const [open, setOpen] = useState(false);
  const viewAll = useViewAll();
  const asking = useAskingForProperty();
  const mine = ownerProperties(me);
  const current = ownerAccountId(me);
  if (mine.length === 0) return null;
  const many = mine.length > 1;
  const all = many && viewAll;                                   // with one property, "all" and "that one" are the same
  const nameOf = (o: (typeof mine)[number], i: number) => o.property_name || o.property_address || `${t('property.newProperty')} ${many ? i + 1 : ''}`.trim();
  const icon = (o: (typeof mine)[number]) => (o.property_status === 'submitted' ? 'clock-outline' : o.property_status === 'verified' ? 'home-city-outline' : 'home-plus-outline');
  const idx = Math.max(0, mine.findIndex((o) => o.owner_account_id === current));
  const sel = mine[idx];
  const shown = all ? t('property.allCount', { count: mine.length }) : nameOf(sel, idx);
  const isOpen = open || asking;
  const toggle = () => { closePropertyAsk(); setOpen(!isOpen); };
  const done = () => { closePropertyAsk(); setOpen(false); };
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ fontWeight: '800', color: brand.teal900 }}>{`${t('property.listLabel')}:`}</Text>
        <Pressable onPress={toggle} accessibilityRole="button" accessibilityState={{ expanded: isOpen }} testID="property-dropdown"
                   accessibilityLabel={`${t('property.title')}: ${shown}`}
                   style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md,
                            backgroundColor: '#fff', borderWidth: 1.5, borderColor: isOpen ? brand.teal700 : brand.line }}>
          <Icon source={all ? 'home-group' : icon(sel)} size={18} color={brand.teal700} />
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: '800', color: brand.ink }} testID="property-shown">{shown}</Text>
          <Icon source={isOpen ? 'menu-up' : 'menu-down'} size={24} color={brand.teal700} />
        </Pressable>
      </View>
      {asking ? <Text style={{ color: '#B45309', fontWeight: '700' }} testID="choose-property-first">{t('property.chooseFirst')}</Text> : null}
      {isOpen ? (
        <View style={{ marginLeft: 0, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden' }}>
          {many ? (
            <Pressable onPress={() => { done(); setViewAll(true); }} accessibilityRole="button" accessibilityState={{ selected: all }} testID="property-all"
                       style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13,
                                                  backgroundColor: all || pressed ? brand.teal50 : '#fff', borderBottomWidth: 1, borderBottomColor: brand.line })}>
              <Icon source={all ? 'check-circle' : 'home-group'} size={20} color={brand.teal700} />
              <Text numberOfLines={1} style={{ flex: 1, fontWeight: all ? '800' : '600', color: brand.ink }}>{t('property.allCount', { count: mine.length })}</Text>
            </Pressable>
          ) : null}
          {mine.map((o, i) => {
            const on = !all && o.owner_account_id === current;
            return (
              <Pressable key={o.owner_account_id} onPress={() => { done(); setViewAll(false); selectOwner(o.owner_account_id); }} accessibilityRole="button"
                         accessibilityState={{ selected: on }} testID={`property-${i}`}
                         style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13,
                                                    backgroundColor: on ? brand.teal50 : pressed ? brand.teal50 : '#fff', borderBottomWidth: i < mine.length - 1 ? 1 : 0, borderBottomColor: brand.line })}>
                <Icon source={on ? 'check-circle' : icon(o)} size={20} color={brand.teal700} />
                <Text numberOfLines={1} style={{ flex: 1, fontWeight: on ? '800' : '600', color: brand.ink }}>{nameOf(o, i)}</Text>
                {o.property_status === 'submitted' ? <Text variant="labelSmall" style={{ color: '#B45309' }}>{t('property.verifying')}</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
