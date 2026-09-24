from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


OUTPUT = "output/pdf/sample_motor_claim_repair_estimate_CLM-3BBFF3BA.pdf"
PAGE_W, PAGE_H = A4
NAVY = colors.HexColor("#142539")
TEAL = colors.HexColor("#167D83")
PALE = colors.HexColor("#EAF3F3")
GRAY = colors.HexColor("#526173")
LINE = colors.HexColor("#D5DFE4")


def text(c, x, y, value, size=10, color=NAVY, font="Helvetica"):
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, y, value)


def right(c, x, y, value, size=10, color=NAVY, font="Helvetica"):
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawRightString(x, y, value)


c = canvas.Canvas(OUTPUT, pagesize=A4)
c.setTitle("Sample Motor Claim Repair Estimate - CLM-3BBFF3BA")
c.setAuthor("Gantry test fixture")

# High-visibility sample marker; the document must not be mistaken for a real estimate.
c.setFillColor(NAVY)
c.rect(0, PAGE_H - 105, PAGE_W, 105, fill=1, stroke=0)
text(c, 42, PAGE_H - 48, "COLLISION REPAIR ESTIMATE", 19, colors.white, "Helvetica-Bold")
text(c, 42, PAGE_H - 72, "Filled sample for motor-claim intake testing", 10, colors.HexColor("#BCE4E0"))
c.setFillColor(colors.HexColor("#D3EDEA"))
c.roundRect(PAGE_W - 176, PAGE_H - 71, 134, 31, 7, fill=1, stroke=0)
text(c, PAGE_W - 162, PAGE_H - 60, "SAMPLE - NOT VALID", 10, TEAL, "Helvetica-Bold")

left = 42
right_edge = PAGE_W - 42
y = PAGE_H - 137
text(c, left, y, "ESTIMATE DETAILS", 9, TEAL, "Helvetica-Bold")
text(c, left, y - 25, "Estimate no.", 9, GRAY)
text(c, left + 100, y - 25, "TEST-EST-1001", 10, NAVY, "Helvetica-Bold")
text(c, 323, y - 25, "Prepared", 9, GRAY)
text(c, 403, y - 25, "23 Sep 2026", 10, NAVY, "Helvetica-Bold")
text(c, left, y - 49, "Workshop", 9, GRAY)
text(c, left + 100, y - 49, "Example Auto Body Works (fictional)", 10)

y -= 85
c.setFillColor(PALE)
c.roundRect(left, y - 93, right_edge - left, 107, 8, fill=1, stroke=0)
text(c, left + 15, y - 6, "CLAIM REFERENCE", 9, TEAL, "Helvetica-Bold")
text(c, left + 15, y - 28, "CLM-3BBFF3BA", 14, NAVY, "Helvetica-Bold")
text(c, 314, y - 6, "POLICY", 9, TEAL, "Helvetica-Bold")
text(c, 314, y - 28, "MOTOR-1001", 12, NAVY, "Helvetica-Bold")
text(c, left + 15, y - 56, "Incident: collision", 10)
text(c, 314, y - 56, "Date: 24 May 2026", 10)
text(c, left + 15, y - 78, "Location: Hyderabad", 10)

y -= 130
text(c, left, y, "ILLUSTRATIVE REPAIR SCOPE", 9, TEAL, "Helvetica-Bold")
text(c, left, y - 20, "The items below are invented test data, not inspected or verified damage.", 9, GRAY)

table_top = y - 43
c.setFillColor(NAVY)
c.roundRect(left, table_top - 28, right_edge - left, 28, 4, fill=1, stroke=0)
text(c, left + 12, table_top - 18, "REPAIR ITEM", 9, colors.white, "Helvetica-Bold")
right(c, right_edge - 12, table_top - 18, "AMOUNT (INR)", 9, colors.white, "Helvetica-Bold")

items = [
    ("Front bumper surface repair and refinish", "12,000.00"),
    ("Left front fender dent repair", "5,500.00"),
    ("Bodywork labour - 8 hours x INR 900", "7,200.00"),
    ("Paint and finishing materials", "3,500.00"),
]
row_y = table_top - 53
for label, amount in items:
    text(c, left + 12, row_y, label, 9)
    right(c, right_edge - 12, row_y, amount, 9)
    c.setStrokeColor(LINE)
    c.line(left, row_y - 12, right_edge, row_y - 12)
    row_y -= 39

row_y -= 6
text(c, 318, row_y, "Subtotal", 9, GRAY)
right(c, right_edge - 12, row_y, "28,200.00", 10, NAVY)
row_y -= 25
text(c, 318, row_y, "Illustrative tax (18%)", 9, GRAY)
right(c, right_edge - 12, row_y, "5,076.00", 10, NAVY)
row_y -= 36
c.setFillColor(PALE)
c.roundRect(299, row_y - 13, right_edge - 299, 34, 5, fill=1, stroke=0)
text(c, 313, row_y, "SAMPLE TOTAL", 10, TEAL, "Helvetica-Bold")
right(c, right_edge - 12, row_y, "INR 33,276.00", 12, NAVY, "Helvetica-Bold")

footer_y = 112
c.setStrokeColor(LINE)
c.line(left, footer_y + 23, right_edge, footer_y + 23)
text(c, left, footer_y + 7, "IMPORTANT", 9, TEAL, "Helvetica-Bold")
text(c, left, footer_y - 9, "For MIA workflow testing only. No workshop inspected a vehicle or issued this estimate.", 9, GRAY)
text(c, left, footer_y - 25, "Not proof of the incident, insurer approval, liability, or a payable amount.", 9, GRAY)
text(c, left, 39, "SAMPLE DOCUMENT  /  CLM-3BBFF3BA", 8, GRAY, "Helvetica-Bold")
right(c, right_edge, 39, "Page 1 of 1", 8, GRAY)

c.showPage()
c.save()
