from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "pdf"
OUTPUT.mkdir(parents=True, exist_ok=True)

NAVY = colors.HexColor("#17324D")
BLUE = colors.HexColor("#2E6F95")
PALE_BLUE = colors.HexColor("#EAF3F8")
PALE_AMBER = colors.HexColor("#FFF4D6")
AMBER = colors.HexColor("#9A6700")
INK = colors.HexColor("#1F2933")
MUTED = colors.HexColor("#5B6770")
LINE = colors.HexColor("#CBD5DC")
WHITE = colors.white


REPORTS = [
    {
        "filename": "motor_claim_report_01_missing_policy_id.pdf",
        "report_ref": "INTAKE-2026-001",
        "policy_number": "MOTOR-1001",
        "claimant": "Aarav",
        "contact": "+91 90000 10001",
        "vehicle": "Maruti Baleno",
        "registration": "DEMO-KA-1001",
        "incident_type": "Collision",
        "incident_date": "22 September 2026",
        "location": "Hyderabad",
        "description": (
            "The vehicle made contact with a concrete pillar while reversing in a "
            "parking area. The rear bumper and left tail lamp show visible damage. "
            "No injuries or third-party property damage were reported."
        ),
        "damage": "Rear bumper dent and scratches; left tail lamp cracked.",
        "documents": "Damage photographs available; provisional repair estimate included below.",
        "repair_estimate": [
            ("Rear bumper repair and repaint", "Dent removal, surface preparation, and paint", 12500),
            ("Left tail lamp replacement", "Replacement assembly and fitting", 6800),
            ("Inspection and labour", "Damage inspection and workshop labour", 2200),
        ],
        "show_policy_notice": False,
        "show_next_steps": False,
    },
    {
        "filename": "motor_claim_report_02_missing_policy_id.pdf",
        "report_ref": "INTAKE-2026-002",
        "claimant": "Neha Sample",
        "contact": "+91 90000 10002",
        "vehicle": "Maruti Swift",
        "registration": "DEMO-MH-2202",
        "incident_type": "Flood / water ingress",
        "incident_date": "21 September 2026",
        "location": "Baner, Pune",
        "description": (
            "The vehicle was parked on a waterlogged street during heavy rainfall. "
            "Water entered the cabin and the vehicle did not start after the water "
            "level receded. The engine was not restarted again."
        ),
        "damage": "Wet cabin, electrical warning lights, and possible engine water ingress.",
        "documents": "Scene photographs available; towing receipt and inspection report pending.",
    },
]


def footer(canvas, doc):
    canvas.saveState()
    width, _ = A4
    canvas.setStrokeColor(LINE)
    canvas.line(18 * mm, 14 * mm, width - 18 * mm, 14 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 9.5 * mm, "Motor insurance claim intake - not an insurer decision")
    canvas.drawRightString(width - 18 * mm, 9.5 * mm, f"Page {doc.page}")
    canvas.restoreState()


def make_report(report):
    path = OUTPUT / report["filename"]
    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=22 * mm,
        title="Repair Estimate",
        author="Motor Insurance Demo",
        subject="Motor claim intake report",
    )

    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=NAVY,
        alignment=TA_LEFT,
        spaceAfter=4 * mm,
    )
    eyebrow = ParagraphStyle(
        "Eyebrow",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=BLUE,
        tracking=1.1,
        spaceAfter=2 * mm,
    )
    section = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=14,
        textColor=NAVY,
        spaceBefore=5 * mm,
        spaceAfter=2 * mm,
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=14,
        textColor=INK,
    )
    small = ParagraphStyle(
        "Small",
        parent=body,
        fontSize=8.5,
        leading=12,
        textColor=MUTED,
    )
    notice_title = ParagraphStyle(
        "NoticeTitle",
        parent=body,
        fontName="Helvetica-Bold",
        fontSize=10,
        leading=13,
        textColor=AMBER,
        alignment=TA_CENTER,
    )
    notice_body = ParagraphStyle(
        "NoticeBody",
        parent=small,
        textColor=INK,
        alignment=TA_CENTER,
    )

    story = [
        Paragraph("MOTOR CLAIM INTAKE", eyebrow),
        Paragraph("Repair Estimate", title),
        Paragraph(
            "This is not a registered claim, coverage confirmation, approval, or settlement decision.",
            small,
        ),
        Spacer(1, 5 * mm),
    ]

    notice = Table(
        [[Paragraph("POLICY REFERENCE NOT PROVIDED", notice_title)],
         [Paragraph("Coverage cannot be checked and the claim cannot be registered until a valid policy reference is supplied and verified.", notice_body)]],
        colWidths=[174 * mm],
    )
    notice.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PALE_AMBER),
                ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#E3B341")),
                ("TOPPADDING", (0, 0), (-1, 0), 9),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 3),
                ("TOPPADDING", (0, 1), (-1, 1), 2),
                ("BOTTOMPADDING", (0, 1), (-1, 1), 9),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ]
        )
    )
    if report.get("show_policy_notice", True):
        story.extend([notice, Spacer(1, 4 * mm)])

    details = [
        ["Intake reference", report["report_ref"], "Current status", "Policy reference supplied"],
        ["Policy number", report.get("policy_number", "Not provided"), "", ""],
        ["Claimant", report["claimant"], "Contact", report["contact"]],
        ["Vehicle", report["vehicle"], "Registration", report["registration"]],
        ["Incident type", report["incident_type"], "Incident date", report["incident_date"]],
        ["Location", report["location"], "", ""],
    ]
    detail_table = Table(details, colWidths=[29 * mm, 58 * mm, 29 * mm, 58 * mm])
    detail_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                ("TEXTCOLOR", (0, 0), (-1, -1), INK),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
                ("TEXTCOLOR", (0, 0), (0, -1), NAVY),
                ("TEXTCOLOR", (2, 0), (2, -1), NAVY),
                ("BACKGROUND", (0, 0), (0, -1), PALE_BLUE),
                ("BACKGROUND", (2, 0), (2, -1), PALE_BLUE),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("SPAN", (1, 1), (3, 1)),
                ("SPAN", (1, 5), (3, 5)),
            ]
        )
    )
    story.extend([Paragraph("Intake summary", section), detail_table])

    story.extend(
        [
            Paragraph("Incident narrative", section),
            Paragraph(report["description"], body),
            Paragraph("Reported damage", section),
            Paragraph(report["damage"], body),
            Paragraph("Evidence status", section),
            Paragraph(report["documents"], body),
        ]
    )

    if report.get("repair_estimate"):
        estimate_rows = [
            ["Repair item", "Scope", "Estimated amount"],
            *[
                [item, scope, f"INR {amount:,.0f}"]
                for item, scope, amount in report["repair_estimate"]
            ],
        ]
        total = sum(amount for _, _, amount in report["repair_estimate"])
        estimate_rows.append(["Estimated total", "Before final inspection", f"INR {total:,.0f}"])
        estimate_table = Table(
            estimate_rows,
            colWidths=[53 * mm, 78 * mm, 43 * mm],
            repeatRows=1,
        )
        estimate_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                    ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                    ("BACKGROUND", (0, -1), (-1, -1), PALE_BLUE),
                    ("ALIGN", (-1, 1), (-1, -1), "RIGHT"),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                    ("FONTSIZE", (0, 0), (-1, -1), 8.2),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ]
            )
        )
        story.extend(
            [
                Paragraph("Provisional repair estimate", section),
                estimate_table,
                Spacer(1, 2 * mm),
                Paragraph(
                    "Estimate is indicative and subject to workshop inspection, parts availability, and final assessment.",
                    small,
                ),
            ]
        )

    next_steps = [
        [Paragraph("1", notice_title), Paragraph("Obtain and verify the policy reference from the claimant.", body)],
        [Paragraph("2", notice_title), Paragraph("Check that the incident date falls inside the verified policy period.", body)],
        [Paragraph("3", notice_title), Paragraph("Assess cover, exclusions, deductible, and required evidence before registration.", body)],
        [Paragraph("4", notice_title), Paragraph("Do not treat intake or evidence collection as claim approval.", body)],
    ]
    steps_table = Table(next_steps, colWidths=[12 * mm, 162 * mm])
    steps_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), PALE_BLUE),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    if report.get("show_next_steps", True):
        story.extend([Paragraph("Required next steps", section), KeepTogether(steps_table)])
        story.extend(
            [
                Spacer(1, 7 * mm),
                Paragraph(
                    "Declaration: The information above is unverified and supplied only for a demonstration. No real customer, insurer, payment, booking, or settlement is involved.",
                    small,
                ),
            ]
        )

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return path


if __name__ == "__main__":
    for item in REPORTS[:1]:
        print(make_report(item))
