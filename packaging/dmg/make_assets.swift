import AppKit
import CoreGraphics

// ── 1. Strip white background (BFS, tol=50, seed all 4 edges) ────────────────

let iconSrc = URL(fileURLWithPath: "frontend/public/querybird-mark.png")
let iconOut = URL(fileURLWithPath: "packaging/dmg/icon_transparent.png")

guard let srcNS = NSImage(contentsOf: iconSrc),
      let cgSrc = srcNS.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { print("ERROR: load icon"); exit(1) }

let W = cgSrc.width, H = cgSrc.height
let cs = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)

let pixCtx = CGContext(data: nil, width: W, height: H,
                       bitsPerComponent: 8, bytesPerRow: W * 4,
                       space: cs, bitmapInfo: bitmapInfo.rawValue)!
pixCtx.draw(cgSrc, in: CGRect(x:0,y:0,width:W,height:H))
let buf = pixCtx.data!.bindMemory(to: UInt8.self, capacity: W*H*4)

let tol = 50
func isWhite(_ pi: Int) -> Bool {
    Int(buf[pi]) >= 255-tol && Int(buf[pi+1]) >= 255-tol && Int(buf[pi+2]) >= 255-tol
}

var visited = [Bool](repeating: false, count: W*H)
var queue = [Int](); queue.reserveCapacity(W*H/4)

func tryEnq(_ x: Int, _ y: Int) {
    guard x>=0,x<W,y>=0,y<H else { return }
    let idx = y*W+x; guard !visited[idx] else { return }
    guard isWhite(idx*4) else { return }
    visited[idx] = true; queue.append(idx)
}

// Seed entire perimeter
for x in 0..<W { tryEnq(x,0); tryEnq(x,H-1) }
for y in 0..<H { tryEnq(0,y); tryEnq(W-1,y) }

var head = 0
while head < queue.count {
    let idx = queue[head]; head += 1
    let pi = idx*4
    buf[pi]=0; buf[pi+1]=0; buf[pi+2]=0; buf[pi+3]=0
    let x = idx%W, y = idx/W
    tryEnq(x+1,y); tryEnq(x-1,y); tryEnq(x,y+1); tryEnq(x,y-1)
}

// Feather anti-aliased edge pixels
for y in 0..<H { for x in 0..<W {
    let pi = (y*W+x)*4
    guard buf[pi+3] > 0 else { continue }
    let r=Int(buf[pi]),g=Int(buf[pi+1]),b=Int(buf[pi+2])
    guard r>180&&g>180&&b>180 else { continue }
    let nearTrans = [(x+1,y),(x-1,y),(x,y+1),(x,y-1)].contains {
        let (nx,ny)=$0; guard nx>=0,nx<W,ny>=0,ny<H else { return false }
        return buf[(ny*W+nx)*4+3]==0
    }
    if nearTrans {
        let lum=(r+g+b)/3
        buf[pi+3] = UInt8(max(0, min(255, (255-lum)*255/75)))
    }
}}

let iconCG = pixCtx.makeImage()!
let iconRep = NSBitmapImageRep(cgImage: iconCG)
try! iconRep.representation(using:.png,properties:[:])!.write(to:iconOut)
print("✓ icon_transparent.png (\(W)x\(H))")

// ── 2. Rebuild .icns ──────────────────────────────────────────────────────────

let iconsetDir = URL(fileURLWithPath: "packaging/dmg/QueryBird.iconset")
try? FileManager.default.removeItem(at: iconsetDir)
try! FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

for (pts,scale,name) in [(16,1,"icon_16x16"),(16,2,"icon_16x16@2x"),
                          (32,1,"icon_32x32"),(32,2,"icon_32x32@2x"),
                          (128,1,"icon_128x128"),(128,2,"icon_128x128@2x"),
                          (256,1,"icon_256x256"),(256,2,"icon_256x256@2x"),
                          (512,1,"icon_512x512"),(512,2,"icon_512x512@2x")] as [(Int,Int,String)] {
    let px = pts*scale
    let rc = CGContext(data:nil,width:px,height:px,bitsPerComponent:8,bytesPerRow:px*4,
                       space:cs,bitmapInfo:bitmapInfo.rawValue)!
    rc.interpolationQuality = .high
    rc.draw(iconCG, in:CGRect(x:0,y:0,width:px,height:px))
    let r2 = NSBitmapImageRep(cgImage:rc.makeImage()!)
    try! r2.representation(using:.png,properties:[:])!
        .write(to:iconsetDir.appendingPathComponent("\(name).png"))
}
print("✓ iconset populated")

// ── 3. DMG background — draw everything right-side-up ────────────────────────
// Use NO coordinate flip on bgCtx. CGContext origin = bottom-left.
// All y coords are measured from the BOTTOM.

let BW=1320, BH=800   // @2x retina; logical = 660×400
let bgOut = URL(fileURLWithPath: "packaging/dmg/background@2x.png")

let bgCtx = CGContext(data:nil,width:BW,height:BH,bitsPerComponent:8,bytesPerRow:BW*4,
                      space:cs,bitmapInfo:CGImageAlphaInfo.premultipliedFirst.rawValue)!
// NO flip — y=0 is at the bottom

// Gradient: top = light blue, bottom = slightly deeper blue
let grad = CGGradient(colorsSpace:cs,
    colors:[CGColor(red:0.88,green:0.93,blue:1.0,alpha:1),
            CGColor(red:0.76,green:0.87,blue:0.99,alpha:1)] as CFArray,
    locations:[0,1])!
bgCtx.drawLinearGradient(grad,
    start:CGPoint(x:0,y:CGFloat(BH)), end:CGPoint(x:0,y:0), options:[])

// White rounded cards (bottom-left origin coords)
// Left card centre: x=330, y=480 (from bottom)  Right: x=990, y=480
func card(_ cx:CGFloat,_ cy:CGFloat) {
    let r = CGRect(x:cx-120,y:cy-130,width:240,height:260)
    bgCtx.setShadow(offset:CGSize(width:0,height:-4),blur:28,
                    color:CGColor(red:0.2,green:0.4,blue:0.8,alpha:0.20))
    bgCtx.setFillColor(CGColor(red:1,green:1,blue:1,alpha:0.90))
    bgCtx.addPath(CGPath(roundedRect:r,cornerWidth:32,cornerHeight:32,transform:nil))
    bgCtx.fillPath()
    bgCtx.setShadow(offset:.zero,blur:0,color:nil)
}
card(330,480); card(990,480)

// Arrow (pointing right, centred at y=480, fits between x=460..860)
bgCtx.setFillColor(CGColor(red:0.22,green:0.47,blue:0.95,alpha:1))
bgCtx.fill(CGRect(x:460,y:472,width:330,height:16))  // shaft
let tip = CGMutablePath()
tip.move(to:   CGPoint(x:790,y:536))
tip.addLine(to:CGPoint(x:790,y:424))
tip.addLine(to:CGPoint(x:862,y:480))
tip.closeSubpath()
bgCtx.addPath(tip); bgCtx.fillPath()

// ── Text via NSAttributedString (needs NSGraphicsContext wrapper) ─────────────
// NSGraphicsContext wrapping a CGContext draws with bottom-left origin naturally.
NSGraphicsContext.saveGraphicsState()
let nsCtx = NSGraphicsContext(cgContext:bgCtx, flipped:false)
NSGraphicsContext.current = nsCtx

let centerPara = NSMutableParagraphStyle(); centerPara.alignment = .center
let blue      = NSColor(calibratedRed:0.15,green:0.38,blue:0.82,alpha:1.0)
let mutedBlue = NSColor(calibratedRed:0.22,green:0.38,blue:0.68,alpha:0.80)

// "Drag to install" — near top, y from bottom ≈ 690
NSAttributedString(string:"Drag to install",
    attributes:[.font:NSFont.systemFont(ofSize:28,weight:.semibold),
                .foregroundColor:blue,
                .paragraphStyle:centerPara])
    .draw(in:CGRect(x:330,y:690,width:660,height:50))

// Sub-labels under cards (y≈300 from bottom)
for (label,lx) in [("QueryBird",80),("Applications",740)] as [(String,Int)] {
    NSAttributedString(string:label,
        attributes:[.font:NSFont.systemFont(ofSize:22,weight:.medium),
                    .foregroundColor:mutedBlue,
                    .paragraphStyle:centerPara])
        .draw(in:CGRect(x:CGFloat(lx),y:300,width:460,height:34))
}

// Version badge (y≈100 from bottom)
let badgeRect = CGRect(x:CGFloat(BW/2-110),y:104,width:220,height:40)
bgCtx.setFillColor(CGColor(red:0.22,green:0.47,blue:0.95,alpha:0.10))
bgCtx.addPath(CGPath(roundedRect:badgeRect,cornerWidth:20,cornerHeight:20,transform:nil))
bgCtx.fillPath()
NSAttributedString(string:"Version 1.0.0",
    attributes:[.font:NSFont.monospacedSystemFont(ofSize:18,weight:.regular),
                .foregroundColor:NSColor(calibratedRed:0.22,green:0.47,blue:0.95,alpha:0.85),
                .paragraphStyle:centerPara])
    .draw(in:CGRect(x:CGFloat(BW/2-110),y:110,width:220,height:32))

NSGraphicsContext.restoreGraphicsState()

// Write with logical size = 660×400
let bgRep = NSBitmapImageRep(cgImage:bgCtx.makeImage()!)
bgRep.size = NSSize(width:660,height:400)
try! bgRep.representation(using:.png,properties:[:])!.write(to:bgOut)
print("✓ background@2x.png (1320×800 px, 660×400 logical)")
