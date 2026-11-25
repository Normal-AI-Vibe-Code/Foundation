/**
 * The code an app shows while it waits for its sign-in in the system browser. After Google, the browser
 * lands on Foundation's own page, which says an app on a computer is asking to sign in as this person,
 * shows the same code, and asks for a press ("This is me, sign that app in" / "Not me"). The app gets its
 * session only after that press, so the person checks the two codes match first.
 */
export function SignInCode({ code }: { code: string }) {
  return (
    <div className="signin-code">
      <div className="f-eyebrow" data-shape="text">
        This app's code
      </div>
      <div className="signin-code-value" data-shape="text" aria-label={`Code ${code.split("").join(" ")}`}>
        {code}
      </div>
      <p className="signin-code-note" data-shape="text">
        Your browser shows a code after Google. Press “This is me” there only if it matches this one.
      </p>
    </div>
  );
}
