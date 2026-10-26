import os
import sys
import smtplib
import argparse
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

def send_email(smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, to_email, subject, body_html, attachment_path=None, smtp_tls="false"):
    msg = MIMEMultipart()
    msg['From'] = smtp_from
    msg['To'] = to_email
    msg['Subject'] = subject

    msg.attach(MIMEText(body_html, 'html'))

    if attachment_path and os.path.exists(attachment_path):
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
        recipients = [r.strip() for r in to_email.split(",") if r.strip()]
        server.sendmail(smtp_from, recipients, msg.as_string())
        server.quit()
        print("Email report sent successfully!")
    except Exception as e:
        print(f"Error sending email: {e}", file=sys.stderr)
        # We do not fail the CI/CD pipeline just because the email delivery failed
        sys.exit(0)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Send performance test email report.")
    parser.add_argument("--to", required=True, help="Recipient email")
    parser.add_argument("--subject", required=True, help="Email subject")
    parser.add_argument("--report", required=True, help="Path to the HTML report")
    parser.add_argument("--build-url", default="", help="Azure DevOps Build URL")
    
    args = parser.parse_args()

    # Load credentials from environment variables (mapped from Azure DevOps Variable Group)
    host = os.environ.get("SMTP_HOST")
    port = os.environ.get("SMTP_PORT", "587")
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD")
    sender = os.environ.get("SMTP_FROM", "perf-alerts@company.com")
    smtp_tls = os.environ.get("SMTP_TLS", "false")

    if not all([host, user, password]):
        print("[WARNING] SMTP_HOST, SMTP_USER, or SMTP_PASSWORD environment variables are missing.")
        print("Please configure the 'performance-test-smtp-secrets' variable group in Azure DevOps.")
        print("Skipping email transmission.")
        sys.exit(0)

    # Process and merge recipient list (Developer requested + Mandatory ones)
    developer_to = args.to
    mandatory_to = os.environ.get("MANDATORY_RECIPIENTS", "").strip()
    if mandatory_to == "$(MANDATORY_RECIPIENTS)":
        mandatory_to = ""  # variable not defined in the variable group -> no mandatory recipients
    
    recipient_list = []
    if developer_to:
        recipient_list.extend([email.strip() for email in developer_to.replace(";", ",").split(",") if email.strip()])
    if mandatory_to:
        recipient_list.extend([email.strip() for email in mandatory_to.replace(";", ",").split(",") if email.strip()])

    # Deduplicate keeping insertion order
    final_recipients = []
    for email in recipient_list:
        if email not in final_recipients:
            final_recipients.append(email)

    to_emails = ", ".join(final_recipients)
    
    if not to_emails:
        print("[WARNING] No recipient email addresses resolved. Skipping email transmission.")
        sys.exit(0)

    print(f"Final resolved recipients: {to_emails}")

    html_content = f"""
    <html>
    <head>
        <style>
            body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333333; }}
            .container {{ padding: 20px; border: 1px solid #dddddd; border-radius: 5px; max-width: 600px; }}
            .header {{ background-color: #0078d4; color: #ffffff; padding: 15px; border-radius: 5px 5px 0 0; margin: -20px -20px 20px -20px; }}
            .header h2 {{ margin: 0; font-weight: 500; }}
            .details {{ background-color: #f3f2f1; padding: 15px; border-radius: 4px; margin-bottom: 20px; }}
            .details table {{ width: 100%; border-collapse: collapse; }}
            .details td {{ padding: 5px 0; }}
            .details td.label {{ font-weight: bold; width: 120px; }}
            .footer {{ font-size: 12px; color: #8a8886; margin-top: 30px; border-top: 1px solid #eaeaea; padding-top: 10px; }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h2>Performance Test Report</h2>
            </div>
            <p>Hello,</p>
            <p>The automated performance stress test execution has completed. You can find the detailed <b>interactive HTML dashboard</b> attached directly to this email.</p>
            
            <div class="details">
                <table>
                    <tr>
                        <td class="label">Pipeline:</td>
                        <td>{os.environ.get('BUILD_DEFINITIONNAME', 'Performance-Stress-Test')}</td>
                    </tr>
                    <tr>
                        <td class="label">Build ID:</td>
                        <td>{os.environ.get('BUILD_BUILDID', 'N/A')}</td>
                    </tr>
                    <tr>
                        <td class="label">Build Link:</td>
                        <td><a href="{args.build_url}">View Build in Azure DevOps</a></td>
                    </tr>
                </table>
            </div>

            <p>Please download and open the attached <code>report.html</code> file in a web browser to analyze transaction response times, load stages, and SLA threshold violations.</p>
            
            <div class="footer">
                This is an automated message sent by the Performance Pipeline Tooling.
            </div>
        </div>
    </body>
    </html>
    """

    send_email(host, port, user, password, sender, to_emails, args.subject, html_content, args.report, smtp_tls)
