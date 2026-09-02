import { Tabs } from 'expo-router'
import { View } from 'react-native'
import { Colors, Typography } from '../../lib/theme'
import { Icon, IconName, AppHeader } from '../../lib/ui'

function TabIcon({ icon, active }: { icon: IconName; active: boolean }) {
  if (active) {
    return (
      <View style={{
        backgroundColor: Colors.secondary,
        borderRadius: 999,
        width: 48, height: 32,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: -2,
      }}>
        <Icon name={icon} size={20} color={Colors.textOnDark} />
      </View>
    )
  }
  return <Icon name={icon} size={22} color={Colors.primary} />
}

export default function TabLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      {/* Single shared branding — identical on every tab page */}
      <AppHeader />
      <View style={{ flex: 1 }}>
        <Tabs
          screenOptions={{
            headerShown: false,
        tabBarStyle: {
          backgroundColor: Colors.bgCard,
          borderTopWidth: 0,
          paddingBottom: 8,
          paddingTop: 6,
          height: 68,
          shadowColor: '#423D3A',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.10,
          shadowRadius: 20,
          elevation: 20,
        },
        tabBarActiveTintColor:   Colors.secondary,
        tabBarInactiveTintColor: Colors.primary,
        tabBarLabelStyle: {
          ...Typography.label,
          fontSize: 9,
          letterSpacing: 1.5,
          marginBottom: 2,
          color: undefined,
        },
      }}
    >
      <Tabs.Screen name="index"   options={{ title: 'Try-On',  tabBarIcon: ({ focused }) => <TabIcon icon="tryOn"   active={focused} /> }} />
      <Tabs.Screen name="style"   options={{ title: 'Style',   tabBarIcon: ({ focused }) => <TabIcon icon="style"   active={focused} /> }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: ({ focused }) => <TabIcon icon="history" active={focused} /> }} />
      <Tabs.Screen name="premium" options={{ title: 'Credits', tabBarIcon: ({ focused }) => <TabIcon icon="premium" active={focused} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ focused }) => <TabIcon icon="profile" active={focused} /> }} />
        </Tabs>
      </View>
    </View>
  )
}
