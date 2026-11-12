import { Component, ReactNode } from "react";

type ErrorBoundaryState = { hasError: boolean; error: any; componentStack: string };

type ErrorBoundaryProps = { children: ReactNode };

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: "" };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(_error: any, info: { componentStack: string }) {
    this.setState({ componentStack: info.componentStack });
  }

  render() {
    if (this.state.hasError) {
      return <div style={{ padding: 20, color: "red", fontFamily: "sans-serif" }}>
        <h2>Something went wrong:</h2>
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {this.state.error instanceof Error
            ? this.state.error.message
            : this.state.error}
          <br />
          <b>Component stack:</b><br />
          {this.state.componentStack}
        </pre>
      </div>;
    }
    return this.props.children;
  }
}

export default ErrorBoundary;