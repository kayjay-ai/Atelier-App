import { VerifyFlow } from '../../components/owner/VerifyFlow'

// Forgot password: the same steps as activation, ending in "Set a new password".
export default function OwnerForgot() {
  return <VerifyFlow purpose="reset" />
}
