// The account area: getting in, getting back in, and the first workspace.
import type { AreaModule } from "../../app/areas.ts";
import { InvitationScreen } from "./Invitation.tsx";
import { NewWorkspaceScreen } from "./NewWorkspace.tsx";
import { ForgotPasswordScreen, ResetPasswordScreen } from "./Password.tsx";
import { SignInScreen } from "./SignIn.tsx";
import { SignUpScreen } from "./SignUp.tsx";
import { VerifyEmailScreen } from "./VerifyEmail.tsx";
import { WaitlistConfirmScreen } from "./Waitlist.tsx";

export const screens: AreaModule<"account">["screens"] = {
  // The root only renders when the address carries a waitlist confirmation; otherwise it redirects.
  root: WaitlistConfirmScreen,
  login: SignInScreen,
  signup: SignUpScreen,
  forgotPassword: ForgotPasswordScreen,
  resetPassword: ResetPasswordScreen,
  verifyEmail: VerifyEmailScreen,
  invitation: InvitationScreen,
  onboarding: NewWorkspaceScreen,
};
