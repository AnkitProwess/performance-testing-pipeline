import os
import sys
import html
import json
import smtplib
import argparse
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

def read_profile(profile_path):
    """The load profile as a dict ({} when it is missing or unreadable; the email still goes out)."""
    if not profile_path:
        return {}
    try:
        with open(profile_path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[WARNING] Could not read the load profile {profile_path}: {e}", file=sys.stderr)
        return {}

def profile_labels(profile):
    """apiName and artifact_version from the load profile, for the email subject."""
    return profile.get("apiName") or "Unknown-API", profile.get("artifact_version") or "N/A"

def read_results(report_path):
    """results.json written next to the report by the engine ({} when the test never produced one)."""
    if not report_path:
        return {}
    path = os.path.join(os.path.dirname(report_path), "results.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def run_start(results):
    """Start of the load test from results.json (end time minus duration); None when unknown."""
    try:
        end = datetime.fromisoformat(str(results["generatedAt"]).replace("Z", "+00:00"))
        return end - timedelta(seconds=float((results.get("run") or {}).get("durationSec") or 0))
    except Exception:
        return None

def display_url(url):
    """Scheme + host + path only: query strings and user info are dropped so a token in a URL never reaches an email."""
    text = str(url or "")
    try:
        parts = urlsplit(text)
        if parts.scheme and parts.netloc:
            return f"{parts.scheme}://{parts.hostname or ''}{':' + str(parts.port) if parts.port else ''}{parts.path}"
    except ValueError:
        pass
    return text.split("?")[0]

METHOD_COLORS = {"GET": "#107c10", "POST": "#0078d4", "PUT": "#c27c0e", "PATCH": "#8764b8", "DELETE": "#d13438"}

def endpoint_rows(profile):
    """One <tr> per endpoint of the profile: number, method, name, URL (all HTML-escaped)."""
    rows = []
    for index, ep in enumerate(profile.get("endpoints") or [], start=1):
        if not isinstance(ep, dict):
            continue
        method = str(ep.get("method") or "GET").upper()
        url = display_url(ep.get("endpoint"))
        name = str(ep.get("name") or "").strip() or (urlsplit(url).path or url)
        color = METHOD_COLORS.get(method, "#605e5c")
        rows.append(f"""
                    <tr>
                        <td style="padding:8px 10px; border-bottom:1px solid #edebe9; color:#605e5c;">{index}</td>
                        <td style="padding:8px 10px; border-bottom:1px solid #edebe9;"><span style="background:{color}; color:#ffffff; font-size:11px; font-weight:bold; padding:2px 7px; border-radius:3px;">{html.escape(method)}</span></td>
                        <td style="padding:8px 10px; border-bottom:1px solid #edebe9; font-weight:bold;">{html.escape(name)}</td>
                        <td style="padding:8px 10px; border-bottom:1px solid #edebe9; font-family:Consolas,monospace; font-size:12px; color:#605e5c; word-break:break-all;">{html.escape(url)}</td>
                    </tr>""")
    return "".join(rows), len(rows)


def split_addresses(value):
    """Comma or semicolon separated list -> list of addresses (empty entries dropped)."""
    return [a.strip() for a in (value or "").replace(";", ",").split(",") if a.strip()]

def unique(addresses, exclude=()):
    """Remove duplicates (case-insensitive), keeping order, and anything already in `exclude`."""
    seen = {a.lower() for a in exclude}
    result = []
    for a in addresses:
        if a.lower() not in seen:
            seen.add(a.lower())
            result.append(a)
    return result

def send_email(smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, to_email, subject, body_html, attachment_paths=(), smtp_tls="false", cc_email=""):
    msg = MIMEMultipart()
    msg['From'] = smtp_from
    msg['To'] = to_email
    if cc_email:
        msg['Cc'] = cc_email
    msg['Subject'] = subject

    msg.attach(MIMEText(body_html, 'html'))

    for attachment_path in attachment_paths:
        if not (attachment_path and os.path.exists(attachment_path)):
            continue
        filename = os.path.basename(attachment_path)
        try:
            with open(attachment_path, "rb") as attachment:
                part = MIMEBase("application", "octet-stream")
                part.set_payload(attachment.read())
                encoders.encode_base64(part)
                part.add_header(
                    "Content-Disposition",
                    f"attachment; filename= {filename}",
                )
                msg.attach(part)
                print(f"Attached file: {attachment_path}")
        except Exception as e:
            print(f"Error attaching file {attachment_path}: {e}", file=sys.stderr)

    try:
        print(f"Connecting to SMTP server {smtp_host}:{smtp_port}...")
        
        # Determine if we should use implicit SSL or STARTTLS
        use_ssl = smtp_tls.lower() in ("true", "ssl") or int(smtp_port) == 465
        
        if use_ssl:
            print("Using implicit SSL/TLS connection...")
            server = smtplib.SMTP_SSL(smtp_host, int(smtp_port))
        else:
            print("Using standard connection upgraded with STARTTLS...")
            server = smtplib.SMTP(smtp_host, int(smtp_port))
            server.starttls()  # Upgrade connection to secure TLS
            
        server.login(smtp_user, smtp_pass)
        print("Logged in successfully. Sending email...")
        # The SMTP envelope carries To + Cc; the Cc header only makes the Cc recipients visible to everyone.
        recipients = unique(split_addresses(to_email) + split_addresses(cc_email))
        server.sendmail(smtp_from, recipients, msg.as_string())
        server.quit()
        print("Email report sent successfully!")
    except Exception as e:
        print(f"Error sending email: {e}", file=sys.stderr)
        # We do not fail the CI/CD pipeline just because the email delivery failed
        sys.exit(0)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Send performance test email report.")
    parser.add_argument("--to", required=True, help="Recipient email(s), comma or semicolon separated")
    parser.add_argument("--cc", default="", help="Optional Cc email(s), comma or semicolon separated (empty = no Cc)")
    parser.add_argument("--subject", default="", help="Email subject (built from --profile when omitted)")
    parser.add_argument("--profile", default="", help="Path to the load profile JSON; supplies apiName and artifact_version for the subject")
    parser.add_argument("--report", required=True, help="Path to the HTML report to attach (report.html)")
    parser.add_argument("--build-url", default="", help="Link to the CI build (Jenkins BUILD_URL)")
    # The result (PASSED / FAILED / SLA MISSED) is deliberately NOT in the email: the email identifies the test, the attached report holds the outcome.
    # --status / --detail are still accepted and ignored so that older pipeline files keep working.
    parser.add_argument("--status", default="", help=argparse.SUPPRESS)
    parser.add_argument("--detail", default="", help=argparse.SUPPRESS)

    args = parser.parse_args()

    # Load credentials from environment variables (Jenkins credentials / Azure DevOps variable group)
    host = os.environ.get("SMTP_HOST")
    port = os.environ.get("SMTP_PORT", "587")
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD")
    sender = os.environ.get("SMTP_FROM") or user or "perf-alerts@company.com"
    smtp_tls = os.environ.get("SMTP_TLS", "false")

    if not all([host, user, password]):
        print("[WARNING] SMTP_HOST, SMTP_USER, or SMTP_PASSWORD environment variables are missing.")
        print("Please configure the 'perf-smtp' credential in Jenkins (or the 'perf-smtp' variable group in Azure DevOps).")
        print("Skipping email transmission.")
        sys.exit(0)

    # Process and merge recipient list (Developer requested + Mandatory ones)
    developer_to = args.to
    mandatory_to = os.environ.get("MANDATORY_RECIPIENTS", "").strip()
    if mandatory_to == "$(MANDATORY_RECIPIENTS)":
        mandatory_to = ""  # variable not defined in the variable group -> no mandatory recipients
    
    # Deduplicate keeping insertion order
    final_recipients = unique(split_addresses(developer_to) + split_addresses(mandatory_to))
    # Cc: an address that is already in To is not repeated
    # 'none' / '-' mean "no Cc": Azure DevOps shows a parameter with an empty default as required, so the pipeline default is 'none'
    cc_value = "" if args.cc.strip().lower() in ("none", "-", "n/a") else args.cc
    final_cc = unique(split_addresses(cc_value), exclude=final_recipients)

    to_emails = ", ".join(final_recipients)
    cc_emails = ", ".join(final_cc)

    if not to_emails:
        print("[WARNING] No recipient email addresses resolved. Skipping email transmission.")
        sys.exit(0)

    print(f"Final resolved recipients: {to_emails}")
    if cc_emails:
        print(f"Cc: {cc_emails}")

    profile = read_profile(args.profile)
    api_name, version = profile_labels(profile)
    subject = args.subject or f"Performance Test Report - {api_name} - Version {version}"

    # Date and time of the test: from results.json (end time minus duration); without it (the test never produced one) the time of sending.
    results = read_results(args.report)
    started = run_start(results)
    when = started or datetime.now(timezone.utc)
    when_text = when.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M:%S UTC")
    rows_html, endpoint_count = endpoint_rows(profile)
    pipeline_name = os.environ.get('JOB_NAME') or os.environ.get('BUILD_DEFINITIONNAME', 'Performance-Stress-Test')
    build_number = os.environ.get('BUILD_NUMBER') or os.environ.get('BUILD_BUILDID', 'N/A')

    def detail_row(label, value, strong=False):
        """One label/value row of the summary table; rows without a value are left out."""
        if value in (None, ""):
            return ""
        weight = "font-weight:bold; font-size:15px;" if strong else ""
        return f"""
                <tr>
                    <td style="padding:7px 12px; width:150px; color:#605e5c; border-bottom:1px solid #edebe9;">{html.escape(label)}</td>
                    <td style="padding:7px 12px; color:#201f1e; border-bottom:1px solid #edebe9; {weight}">{value}</td>
                </tr>"""

    build_rows = "".join([
        detail_row("Pipeline", html.escape(str(pipeline_name))),
        detail_row("Build", html.escape(str(build_number))),
        detail_row("Build link", f'<a href="{html.escape(args.build_url, quote=True)}" style="color:#0078d4;">View build</a>' if args.build_url else ""),
    ])
    endpoints_block = f"""
            <h3 style="font-size:15px; margin:24px 0 8px 0; color:#201f1e;">Endpoints tested</h3>
            <table cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; font-size:13px; border:1px solid #edebe9;">
                <tr style="background:#f3f2f1; text-align:left;">
                    <th style="padding:8px 10px; width:28px;">#</th>
                    <th style="padding:8px 10px; width:70px;">Method</th>
                    <th style="padding:8px 10px;">Endpoint</th>
                    <th style="padding:8px 10px;">URL</th>
                </tr>{rows_html}
            </table>""" if rows_html else ""

    has_report = bool(args.report) and os.path.exists(args.report)
    report_note = ("The detailed interactive report is attached as <b>report.html</b>. Download it and open it in a web browser to see the results: response times, load stages and SLA thresholds."
                   if has_report else "No report is attached because the test did not get as far as generating load. The build log has the details.")

    html_content = f"""
    <html>
    <body style="margin:0; padding:0; font-family:Arial, Helvetica, sans-serif; color:#333333; line-height:1.5;">
        <div style="max-width:680px; padding:20px; border:1px solid #dddddd; border-radius:5px;">
            <div style="background-color:#0078d4; color:#ffffff; padding:16px 20px; border-radius:5px 5px 0 0; margin:-20px -20px 20px -20px;">
                <div style="font-size:12px; letter-spacing:1px; text-transform:uppercase; opacity:0.85;">Performance Test Report</div>
                <div style="font-size:20px; font-weight:bold; margin-top:2px;">{html.escape(str(api_name))}</div>
            </div>
            <p style="margin:0 0 16px 0;">Hello,<br>The automated performance test has finished.</p>

            <p style="margin:0 0 4px 0; font-size:13px; color:#605e5c;">Test run</p>
            <p style="margin:0; font-size:16px; font-weight:bold; color:#201f1e;">{html.escape(when_text)}</p>
            {endpoints_block}

            <h3 style="font-size:15px; margin:24px 0 8px 0; color:#201f1e;">Pipeline run</h3>
            <table cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; font-size:13px; border:1px solid #edebe9;">{build_rows}
            </table>

            <p style="margin:20px 0 0 0;">{report_note}</p>

            <div style="font-size:12px; color:#8a8886; margin-top:28px; border-top:1px solid #eaeaea; padding-top:10px;">
                This is an automated message sent by the Performance Pipeline Tooling.
            </div>
        </div>
    </body>
    </html>
    """

    send_email(host, port, user, password, sender, to_emails, subject, html_content, [args.report], smtp_tls, cc_emails)
