import { ReactNode } from 'react'
import { router } from 'expo-router'
import { AuthFrame } from '../AuthFrame'
import { AccountKindSwitch } from '../AccountKindSwitch'

/**
 * The frame of the owner's sign-in pages (login, activation, forgot password):
 * the shared sign-in frame with the Personal / Company › Owner switch, so it
 * reads as the same sign-in page.
 */
export function AuthShell({ title, subtitle, children, showSwitch = true }: {
  title: string; subtitle?: string; children: ReactNode; showSwitch?: boolean
}) {
  return (
    <AuthFrame
      audience="company"
      title={title}
      subtitle={subtitle}
      top={showSwitch ? (
        <AccountKindSwitch
          value="owner"
          onChange={(role) => {
            if (role === 'personal') router.replace('/auth')
            else if (role === 'store') router.replace('/auth?as=company')
          }}
        />
      ) : undefined}
    >
      {children}
    </AuthFrame>
  )
}
