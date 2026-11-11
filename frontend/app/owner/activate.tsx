import { VerifyFlow } from '../../components/owner/VerifyFlow'

// First-time activation: store code + email → emailed code → create password.
export default function OwnerActivate() {
  return <VerifyFlow purpose="activation" />
}
