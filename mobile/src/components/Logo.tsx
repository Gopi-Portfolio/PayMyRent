// PayMyRent logo: a house (property) with a ₹ coin (rent) on a teal tile. Pure SVG, scales crisply.
import React from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop, Text as SvgText, TextPath } from 'react-native-svg';

export function LogoMark({ size = 64, tile = true }: { size?: number; tile?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96" accessibilityLabel="PayMyRent logo">
      <Defs>
        <LinearGradient id="rg-tile" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#14A58D" />
          <Stop offset="1" stopColor="#064E45" />
        </LinearGradient>
        <LinearGradient id="rg-coin" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#FCD34D" />
          <Stop offset="1" stopColor="#F59E0B" />
        </LinearGradient>
      </Defs>
      {tile ? <Rect x="0" y="0" width="96" height="96" rx="26" fill="url(#rg-tile)" /> : null}
      {/* house */}
      <Path d="M20 46 L48 22 L76 46" fill="none" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M28 44 V72 a4 4 0 0 0 4 4 H64 a4 4 0 0 0 4 -4 V44" fill="none" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      {/* rupee coin */}
      <Circle cx="48" cy="56" r="12.5" fill="url(#rg-coin)" />
      <G transform="translate(48 56) scale(0.95)" fill="none" stroke="#064E45" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <Path d="M-5.5 -6 H5.5 M-5.5 -1.5 H5.5 M-4 -6 H-0.5 C4 -6 4 2.5 -0.5 2.5 H-4 L3.5 9.5" />
      </G>
    </Svg>
  );
}

/** Wordmark: yellow R whose leg runs on as one straight line under "ent" (a single drawn stroke, so no seam), "ent", a G with a yellow "go" arrow, and "o". */
/** How far (logo units) the line runs past "ent" so its arrow tip touches the G's left edge. Tweak if there is a gap or overlap. */
const LINE_REACH = 3;

export function Wordmark({ size = 44, light = false }: { size?: number; light?: boolean }) {
  const fs = size * 0.62;
  const main = light ? '#FFFFFF' : '#0B6E5F';
  const accent = light ? '#FCD34D' : '#F59E0B';
  const box = fs * 1.12;
  const k = box / 44;
  const h = Math.max(box, fs * 1.15) + 3 * k;
  const [w, setW] = React.useState(0);          // width of "R + ent", measured so the line ends exactly with "ent"
  const txt = { fontSize: fs, fontWeight: '800' as const, letterSpacing: -0.8, color: main, lineHeight: fs * 1.15 };
  const rWidth = box * 0.86;
  const lineEnd = w > 0 ? w / k + LINE_REACH + 5 / k : 38;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessibilityLabel="PayMyRent" accessibilityRole="image">
      <View style={{ flexDirection: 'row', alignItems: 'center', height: h, zIndex: 2 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        <View style={{ width: rWidth, height: box }} />
        <Text style={txt}>ent</Text>
        {/* R and the line are ONE path, drawn in one SVG, so the foot of the leg and the line can never have a gap */}
        <Svg pointerEvents="none" width={Math.max(lineEnd, 38) * k} height={box + 12 * k} viewBox={`0 0 ${Math.max(lineEnd, 38)} 56`}
             style={{ position: 'absolute', left: 0, top: (h - box) / 2, overflow: 'visible' }}>
          <G fill="none" stroke={accent} strokeWidth={6} strokeLinecap="butt" strokeLinejoin="miter">
            <Path d={`M12 ${40 + 3 / k}V6H22a10 10 0 0 1 0 20H12M22 26L34 40H${Math.max(lineEnd, 38) - 5}`} />
          </G>
          {/* little "go" arrowhead at the end of the line, same style as the G's arrow */}
          <G fill="none" stroke={accent} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round">
            <Path d={`M${Math.max(lineEnd, 38) - 11} 31L${Math.max(lineEnd, 38) - 2.5} 40L${Math.max(lineEnd, 38) - 11} 49`} />
          </G>
        </Svg>
      </View>
      <Svg width={box} height={box} viewBox="0 0 44 44">
        <G fill="none" stroke={main} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M33 10A17 17 0 1 0 35.7 31V24H22" />
        </G>
        <G fill="none" stroke={accent} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M29 24H40" strokeWidth={6} />
          <Path d="M34 17L41 24L34 31" strokeWidth={5} />
        </G>
      </Svg>
      <Text style={txt}>o</Text>
    </View>
  );
}

let animateUntil = 0;   // set when the role is switched; every logo mounted/updated inside this window plays the intro

/** Call when the user switches role (Owner ⇄ Tenant) so the RG logo replays its intro on whatever screen shows next. */
export function playLogoIntro() { animateUntil = Date.now() + 2500; }

/** Compact monogram for inside pages. On a role switch: the R and the G ring appear first, then the G's arrow slides in from the left. */
export function RGMark({ size = 40, light = false, animateOn }: { size?: number; light?: boolean; animateOn?: string }) {
  const main = light ? '#FFFFFF' : '#0B6E5F';
  const accent = light ? '#FCD34D' : '#F59E0B';
  const start = Date.now() < animateUntil ? 0 : 1;               // hidden from the very first frame when an intro is due
  const rIn = React.useRef(new Animated.Value(start)).current;       // R: 0 off to the left -> 1 in place
  const gIn = React.useRef(new Animated.Value(start)).current;       // G ring: same, a beat later
  const slide = React.useRef(new Animated.Value(start)).current;     // arrow: 0 off to the left -> 1 in place
  React.useEffect(() => {
    if (Date.now() >= animateUntil) return;
    rIn.setValue(0); gIn.setValue(0); slide.setValue(0);
    Animated.sequence([
      Animated.delay(350),                                          // let the new screen finish appearing first
      Animated.timing(rIn, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(gIn, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(slide, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [animateOn, rIn, gIn, slide]);
  const fromLeft = (v: Animated.Value, dist: number) => ({
    opacity: v.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1] }),
    transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [-dist, 0] }) }],
  });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }} accessibilityLabel="PayMyRent" accessibilityRole="image">
      <Animated.View style={fromLeft(rIn, size * 2.4)}>
        <Svg width={size * 0.8} height={size} viewBox="0 0 38 44">
          <G fill="none" stroke={accent} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M12 38V4H22a10 10 0 0 1 0 20H12M22 24L34 38" />
          </G>
        </Svg>
      </Animated.View>
      <View style={{ width: size, height: size, marginLeft: -size * 0.04, overflow: 'hidden' }}>
        <Animated.View style={[StyleSheet.absoluteFill, fromLeft(gIn, size * 1.4)]}>
          <Svg width={size} height={size} viewBox="0 0 44 44">
            <G fill="none" stroke={main} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M33 10A17 17 0 1 0 35.7 31V24H22" />
            </G>
          </Svg>
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, fromLeft(slide, size * 0.8)]}>
          <Svg width={size} height={size} viewBox="0 0 44 44">
            <G fill="none" stroke={accent} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M24 24H40" strokeWidth={6} />
              <Path d="M34 17L41 24L34 31" strokeWidth={5} />
            </G>
          </Svg>
        </Animated.View>
      </View>
    </View>
  );
}

/** Sunrise over a house: the new-month, fresh-start mark used on the landing and login screens, with the plain "PayMyRent" name below. */
export function SunriseMark({ size = 96, light = true }: { size?: number; light?: boolean }) {
  const roof = light ? '#064E45' : '#064E45';
  const body = light ? '#FFFFFF' : '#0B6E5F';
  const door = light ? '#0B6E5F' : '#FFFFFF';
  const w = (size * 120) / 96;
  return (
    <Svg width={w} height={size} viewBox="0 0 120 96" accessibilityLabel="PayMyRent logo">
      <Defs>
        <LinearGradient id="rg-sun" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#FDE68A" /><Stop offset="1" stopColor="#F59E0B" />
        </LinearGradient>
      </Defs>
      <Circle cx="60" cy="52" r="30" fill="url(#rg-sun)" />
      <G stroke="#FCD34D" strokeWidth="4" strokeLinecap="round">
        <Path d="M60 8V16M22 22L28 28M98 22L92 28M8 52H16M104 52H112" />
      </G>
      <Path d="M30 62L60 38L90 62V90H30Z" fill={body} />
      <Path d="M26 64L60 36L94 64" fill="none" stroke={roof} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <Rect x="52" y="68" width="16" height="22" rx="3" fill={door} />
    </Svg>
  );
}


/** The paymyrents logo: a sunrise over a house with MY inside it, PAY curved over the sun and RENTS across the foot of the house.
 *  `light` = for a dark/teal background (white house and text); otherwise for a white background (teal house and text).
 *  `height` is the whole logo's height; the width follows. Pure SVG, so it scales crisply. */
let pmrCount = 0;
export function PayMyRentsLogo({ height = 120, light = true }: { height?: number; light?: boolean }) {
  const id = React.useRef(`pmr${++pmrCount}`).current;
  const body = light ? '#FFFFFF' : '#0B6E5F';
  const door = light ? '#0B6E5F' : '#FFFFFF';
  const text = light ? '#FFFFFF' : '#0B6E5F';
  const w = (height * 140) / 150;
  return (
    <Svg width={w} height={height} viewBox="40 42 140 150" accessibilityLabel="paymyrents" accessibilityRole="image">
      <Defs>
        <LinearGradient id={`${id}sun`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#FDE68A" /><Stop offset="1" stopColor="#F59E0B" />
        </LinearGradient>
        <Path id={`${id}arc`} d="M 60.5 112 A 49.5 49.5 0 0 1 159.5 112" fill="none" />
      </Defs>
      <G transform="translate(20 34) scale(1.5)">
        <Circle cx="60" cy="52" r="30" fill={`url(#${id}sun)`} />
        <Path d="M96.0 55.0L104.0 55.0M88.4 32.8L94.7 27.9M31.6 32.8L25.3 27.9M24.0 55.0L16.0 55.0" stroke="#FCD34D" strokeWidth="3" strokeLinecap="round" fill="none" />
        <Path d="M30 62L60 38L90 62V90H30Z" fill={body} />
        <Path d="M26 64L60 36L94 64" fill="none" stroke="#064E45" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        <Rect x="52" y="70" width="16" height="20" rx="3" fill={door} />
        <SvgText x="60" y="65" fontSize="17" fontWeight="800" letterSpacing="0.5" fill={door} textAnchor="middle">MY</SvgText>
      </G>
      <SvgText fontSize="18" fontWeight="800" letterSpacing="4.5" fill={text} textAnchor="middle">
        <TextPath href={`#${id}arc`} startOffset="50%">PAY</TextPath>
      </SvgText>
      <SvgText x="114" y="186" fontSize="13" fontWeight="800" letterSpacing="10" fill={text} textAnchor="middle">RENTS</SvgText>
    </Svg>
  );
}

/** The top-bar logo for inside pages: just the sunrise-over-a-house icon, with the name "Pay / My / Rent" on three lines beside it. */
export function PayMyRentBarLogo({ height = 44, light = true }: { height?: number; light?: boolean }) {
  const body = light ? '#FFFFFF' : '#0B6E5F';
  const door = light ? '#0B6E5F' : '#FFFFFF';
  const text = light ? '#FFFFFF' : '#0B6E5F';
  const id = React.useRef(`pmrb${++pmrCount}`).current;
  const fs = height * 0.27 - 2;   // 2 smaller than before
  const line = { color: text, fontSize: fs, lineHeight: fs * 1.05, fontWeight: '800' as const, letterSpacing: 0.3 };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 }} accessibilityLabel="PayMyRent" accessibilityRole="image">
      <Svg width={(height * 92) / 90} height={(height * 71) / 90} viewBox="14 21 92 71">
        <Defs>
          <LinearGradient id={`${id}sun`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#FDE68A" /><Stop offset="1" stopColor="#F59E0B" />
          </LinearGradient>
        </Defs>
        <Circle cx="60" cy="52" r="30" fill={`url(#${id}sun)`} />
        <Path d="M96.0 55.0L104.0 55.0M88.4 32.8L94.7 27.9M31.6 32.8L25.3 27.9M24.0 55.0L16.0 55.0" stroke="#FCD34D" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        <Path d="M30 62L60 38L90 62V90H30Z" fill={body} />
        <Path d="M26 64L60 36L94 64" fill="none" stroke="#064E45" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        <Rect x="52" y="70" width="16" height="20" rx="3" fill={door} />
      </Svg>
      <View>
        <Text style={line}>Pay</Text>
        <Text style={line}>My</Text>
        <Text style={line}>Rent</Text>
      </View>
    </View>
  );
}

/** Landing / sign-in logo (and the home logo in the top bar). `size` keeps the old meaning: the logo is about 2.5 x that tall. */
export function Logo({ size = 44, light = false }: { size?: number; light?: boolean; stacked?: boolean }) {
  return <PayMyRentsLogo height={size * 2.5} light={light} />;
}
