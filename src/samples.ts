// Sample messages for the demo. They are fictional: names, numbers, IDs and
// domains are made up. Each one follows a pattern described in a real public
// report (see docs/sources.md), so the demo shows the kind of message job
// seekers actually receive.

export interface Sample {
  id: string;
  label: string;
  basis: string;
  basisUrl: string;
  text: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'fee',
    label: '"Registration fee" offer',
    basis: 'Fake airline jobs with registration fees, Delhi police case reported 24 Aug 2026',
    basisUrl: 'https://telanganatoday.com/six-arrested-for-fake-airline-job-racket-using-bretish-airways-websites',
    text: `Dear Asha Verma,

Congratulations! Based on your Naukri profile you have been selected for the post of Customer Support Executive (Work From Home) at Amazon India. Salary Rs 38,000/month + incentives, 4 hours daily. No interview required.

To confirm your joining kindly pay the refundable registration fee of Rs 2,500 to our HR Priya Sharma, UPI priya.sharma.hr@okaxis, within 24 hours or the offer will be cancelled.

Also send Aadhaar card, PAN card and bank passbook photo on WhatsApp +91 98765 43210 for verification.

Regards,
HR Team
amazonindia.hiring.desk@gmail.com`,
  },
  {
    id: 'task',
    label: 'Telegram "task" job',
    basis: 'Telegram "Amazon India" task scam, Bengaluru, reported 8 Oct 2025; FTC data on task scams, Dec 2024',
    basisUrl: 'https://www.deccanherald.com/india/karnataka/bengaluru/moonlighting-gone-awry-bengaluru-man-loses-over-rs-67-lakh-in-part-time-job-fraud-3756646',
    text: `Hi, I am Rohan from TalentBridge Placements. We got your number from a job portal.

Part time job, work from mobile: like YouTube videos and rate hotels on Google Maps. Earn Rs 150 per like, daily income Rs 3,000 to 8,000. Payment same day.

Join our Telegram group t.me/tb_daily_tasks to start. First 3 tasks are free. After that you do prepaid tasks for 30% commission.

Limited seats, reply today. Contact me on WhatsApp 9123456780.`,
  },
  {
    id: 'real',
    label: 'Normal interview invite',
    basis: 'A plain recruiter message with no warning signs, to show Tripwire does not cry wolf',
    basisUrl: '',
    text: `Hi Asha,

Thank you for applying for the Backend Engineer (Java) role at Infosys, Bengaluru. We would like to invite you to a first-round technical interview on 2 December at 11:00 IST over Microsoft Teams.

The calendar invite will come from talent.acquisition@infosys.com. Please reply with two other times that work for you, in case this slot does not.

Best regards,
Meera Iyer
Talent Acquisition, Infosys`,
  },
];

/**
 * Draw a fictional chat screenshot onto a canvas so the image path can be
 * demoed without anyone's real chat. Returns a PNG data URL.
 */
export function drawSampleScreenshot(): string {
  const W = 720;
  const lines = [
    { me: false, t: 'Hello sir/madam, I am Kavya from' },
    { me: false, t: 'Global Hiring Solutions. Your profile' },
    { me: false, t: 'is shortlisted for Data Entry job.' },
    { me: false, t: 'Salary 52,000/month. No interview.' },
    { me: true, t: 'What do I need to do?' },
    { me: false, t: 'Pay laptop security deposit Rs 4,999' },
    { me: false, t: 'today to kavya.ghs@ybl and send' },
    { me: false, t: 'your PAN number for joining letter.' },
    { me: false, t: 'Offer valid only 2 hours.' },
  ];
  const H = 140 + lines.length * 52 + 60;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ECE5DD';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1F2C34';
  g.fillRect(0, 0, W, 96);
  g.fillStyle = '#ffffff';
  g.font = '600 30px system-ui, sans-serif';
  g.fillText('+91 70000 12345', 96, 46);
  g.font = '22px system-ui, sans-serif';
  g.fillStyle = '#AEBAC1';
  g.fillText('online', 96, 78);
  g.fillStyle = '#6B7C85';
  g.beginPath();
  g.arc(48, 48, 26, 0, Math.PI * 2);
  g.fill();
  let y = 130;
  g.font = '26px system-ui, sans-serif';
  for (const l of lines) {
    const w = g.measureText(l.t).width + 36;
    const x = l.me ? W - w - 24 : 24;
    g.fillStyle = l.me ? '#D9FDD3' : '#FFFFFF';
    g.beginPath();
    g.roundRect(x, y, w, 44, 10);
    g.fill();
    g.fillStyle = '#111B21';
    g.fillText(l.t, x + 18, y + 31);
    y += 52;
  }
  g.fillStyle = '#667781';
  g.font = '20px system-ui, sans-serif';
  g.fillText('Fictional sample made by Tripwire', 24, H - 24);
  return c.toDataURL('image/png');
}
