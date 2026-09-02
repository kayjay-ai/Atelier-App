import React, { useEffect, useRef, useState } from 'react'
import { View, Image, Animated, Easing, StyleSheet, Platform } from 'react-native'
import { router } from 'expo-router'
import { Colors } from '../lib/theme'

// ─── Web splash — pure CSS transitions ────────────────────────────────────────
function SplashWeb() {
  const [entered, setEntered] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const t1 = setTimeout(() => setEntered(true), 80)
    const t2 = setTimeout(() => setLeaving(true), 3200)
    const t3 = setTimeout(() => router.replace('/auth'), 3620)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return React.createElement(
    'div',
    {
      style: {
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: Colors.bg,
        padding: '48px',
        opacity: leaving ? 0 : 1,
        transition: leaving ? 'opacity 0.4s ease' : 'none',
        pointerEvents: leaving ? 'none' : 'auto',
      },
    },
    React.createElement('style', { key: 'kf' }, `
      @keyframes sparklePulse {
        0%, 100% { transform: scale(1); filter: brightness(1); }
        50%       { transform: scale(1.025); filter: brightness(1.08) drop-shadow(0 0 14px rgba(190,172,146,0.45)); }
      }
    `),
    React.createElement('div', {
      key: 'wrap',
      style: {
        width: '100%', maxWidth: '420px',
        opacity: entered ? 1 : 0,
        transform: entered ? 'scale(1)' : 'scale(1.06)',
        transition: 'opacity 1s ease 0.2s, transform 1.4s ease 0.2s',
        animation: entered ? 'sparklePulse 0.76s ease 1.1s 1 both' : 'none',
      },
    },
      React.createElement('img', {
        key: 'img',
        src: '/logo-quasar-atelier.svg',
        alt: "Quasar's Atelier",
        style: { width: '100%', height: 'auto', display: 'block' },
      }),
    ),
  )
}

// ─── Native splash — React Native Animated ────────────────────────────────────
// For native build: place the logo at assets/logo-quasar-atelier.png
// and swap { uri: '' } for require('../assets/logo-quasar-atelier.png')
function SplashNative() {
  const opacity = useRef(new Animated.Value(0)).current
  const master  = useRef(new Animated.Value(1)).current

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1, duration: 1000, delay: 200,
      easing: Easing.out(Easing.ease), useNativeDriver: true,
    }).start()
    const t = setTimeout(() => {
      Animated.timing(master, { toValue: 0, duration: 380, useNativeDriver: true }).start()
      setTimeout(() => router.replace('/auth'), 410)
    }, 3200)
    return () => clearTimeout(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Animated.View style={[s.container, { opacity: master }]}>
      <Animated.View style={{ opacity }}>
        <Image source={{ uri: '' }} style={s.logo} resizeMode="contain" />
      </Animated.View>
    </Animated.View>
  )
}

// ─── Route entry point ─────────────────────────────────────────────────────────
export default function SplashScreen() {
  return Platform.OS === 'web' ? <SplashWeb /> : <SplashNative />
}

const s = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: Colors.bg,
    alignItems: 'center', justifyContent: 'center', padding: 48,
  },
  logo: { width: '100%', maxWidth: 420, aspectRatio: 1206 / 816, maxHeight: 320 },
})
