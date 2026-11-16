// Hero illustration: a street of buildings with rent coins, drawn in brand colours.
import React from 'react';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';

export function HeroIllustration({ width = 320 }: { width?: number }) {
  const h = (width * 150) / 320;
  return (
    <Svg width={width} height={h} viewBox="0 0 320 150" accessibilityLabel="Buildings illustration">
      <Defs>
        <LinearGradient id="il-coin" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#FDE68A" /><Stop offset="1" stopColor="#F59E0B" />
        </LinearGradient>
      </Defs>
      {/* ground glow */}
      <Rect x="0" y="128" width="320" height="22" fill="rgba(255,255,255,0.10)" />
      {/* apartment block */}
      <Rect x="196" y="38" width="62" height="92" rx="6" fill="#FFFFFF" opacity="0.95" />
      {[0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => (
        <Rect key={`${r}${c}`} x={205 + c * 17} y={48 + r * 19} width="10" height="12" rx="2" fill={(r + c) % 3 === 0 ? '#FCD34D' : '#BFE3B4'} />
      )))}
      <Rect x="220" y="112" width="14" height="18" rx="2" fill="#1F8A02" />
      {/* shop with awning */}
      <Rect x="92" y="70" width="96" height="60" rx="5" fill="#FFFFFF" />
      <Path d="M86 70 H194 L186 52 H94 Z" fill="#F59E0B" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Path key={i} d={`M${94 + i * 16} 52 h16 l${i % 2 ? 2 : -2} 18 h-16 z`} fill={i % 2 ? '#FFFFFF' : '#F59E0B'} opacity={i % 2 ? 0.9 : 1} />
      ))}
      <Rect x="104" y="84" width="36" height="46" rx="3" fill="#1F8A02" />
      <Rect x="108" y="88" width="28" height="30" rx="2" fill="#BFE3B4" />
      <Rect x="152" y="86" width="26" height="22" rx="3" fill="#3FA81F" />
      <SvgText x="165" y="103" fontSize="17" fontWeight="bold" fill="#FFFFFF" opacity="0.85" textAnchor="middle">P</SvgText>
      <Circle cx="170" cy="118" r="4" fill="#F59E0B" />
      {/* house */}
      <Path d="M24 84 L62 52 L100 84 Z" fill="#0F4D00" />
      <Rect x="32" y="84" width="60" height="46" rx="3" fill="#FFFFFF" />
      <Rect x="54" y="102" width="16" height="28" rx="2" fill="#F59E0B" />
      <Rect x="38" y="92" width="12" height="12" rx="2" fill="#BFE3B4" />
      <Rect x="74" y="92" width="12" height="12" rx="2" fill="#BFE3B4" />
      <SvgText x="62" y="122" fontSize="17" fontWeight="bold" fill="#FFFFFF" opacity="0.85" textAnchor="middle">V</SvgText>
      {/* trees */}
      <G>
        <Rect x="272" y="106" width="5" height="24" fill="#0F4D00" />
        <Circle cx="274.5" cy="100" r="15" fill="#34D399" opacity="0.9" />
        <SvgText x="274.5" y="106" fontSize="16" fontWeight="bold" fill="#FFFFFF" opacity="0.85" textAnchor="middle">V</SvgText>
        <Rect x="8" y="112" width="4" height="18" fill="#0F4D00" />
        <Circle cx="10" cy="108" r="10" fill="#34D399" opacity="0.9" />
        <SvgText x="10" y="113" fontSize="13" fontWeight="bold" fill="#FFFFFF" opacity="0.85" textAnchor="middle">G</SvgText>
      </G>
      {/* floating rupee coins */}
      <G>
        <Circle cx="150" cy="26" r="15" fill="url(#il-coin)" />
        <SvgText x="150" y="32" fontSize="17" fontWeight="bold" fill="#0F4D00" textAnchor="middle">₹</SvgText>
        <Circle cx="108" cy="38" r="8" fill="url(#il-coin)" opacity="0.9" />
        <Circle cx="288" cy="52" r="10" fill="url(#il-coin)" opacity="0.9" />
        <SvgText x="288" y="56" fontSize="11" fontWeight="bold" fill="#0F4D00" textAnchor="middle">₹</SvgText>
      </G>
    </Svg>
  );
}
