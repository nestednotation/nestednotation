# Nested Notation Web

A web-based interactive musical notation system for collaborative, multi-player performances using SVG-based graphical scores.

## What is Nested Notation?

Nested Notation is a platform for presenting and performing interactive graphical musical scores. It enables musicians to navigate through musical compositions where each "frame" or page contains multiple possible paths forward. Players make collective decisions about which direction to take through the piece, creating unique performances each time.

## Key Features

### Interactive Graphical Scores
- **SVG-Based Notation**: Musical scores are represented as SVG graphics with embedded navigation links
- **Multi-Path Navigation**: Each frame can contain multiple possible next frames, allowing performers to choose their path through the piece
- **Real-Time Synchronization**: All connected devices see the same current frame simultaneously via WebSocket connections

### Collaborative Performance Modes
- **Guide Mode**: A designated guide/conductor controls navigation for all performers
- **Node Mode**: Collective decision-making through voting
- **Chord Mode**: Hold and transition behaviors for synchronized group movement
- **Voting System**: Democratic navigation with configurable voting duration and visual feedback

### Audio Integration
- **Synchronized Playback**: Optional audio files can accompany each frame
- **Sound Continuity**: Intelligent audio continuation between frames with smooth transitions
- **Fade Control**: Configurable fade duration for seamless audio transitions

### Session Management
- **Multiple Sessions**: Host multiple independent performance sessions simultaneously
- **Role-Based Access**: Separate passwords for administrators (guides) and players
- **Session Persistence**: Performance state is saved between server deployments
- **QR Code Sharing**: Easy joining via QR codes for mobile devices

### Performance Features
- **History Navigation**: Review and return to previous frames
- **Pause/Resume**: Control performance flow with pause functionality
- **Documentation**: Built-in "about" sections for both the platform and individual scores
- **Responsive Design**: Works on desktop, tablet, and mobile devices

## Architecture Overview

### Technology Stack
- **Backend**: Node.js with Express.js framework
- **Views**: Jade/Pug templating engine
- **Real-Time Communication**: WebSocket protocol for live synchronization
- **Database**: In-memory database with file-based persistence
- **Caching**: API caching for improved performance

### Core Components

#### Routes
- `/` - Landing page for session access
- `/session` - Active performance sessions
- `/admin` - Administrative interface
- `/setup` - Session configuration
- `/sm` - Session management (create, modify, delete)
- `/finish` - Performance completion

#### Data Structure
- **Scores**: Stored in `/public/data/` as collections of SVG files
- **Session State**: Persisted in `/server_state/` directory
- **Audio Files**: Organized in `Sounds/` subfolder (optional)
- **Frames**: Stored in `Frames/` subfolder for audio-enabled scores

#### Message Types
The system uses a message-based protocol for real-time communication:
- Tap/Click events
- Frame display commands
- Voting state updates
- Hold/standby timing
- Connection status

## How to Use

### For Performers

1. **Join a Session**
   - Navigate to the application URL
   - Enter the session name
   - Enter player password (or leave blank for "rider" mode)
   - Click "GO"

2. **Navigate the Score**
   - In Guide Mode: Follow the guide's navigation
   - In Node Mode: Vote on next frame by tapping choices
   - In Chord Mode: Tap and hold choices for synchronized movement

### For Administrators/Guides

1. **Create a Session**
   - Log in to admin panel
   - Select a score from available options
   - Configure session settings:
     - Session name
     - Admin password
     - Player password
     - Voting duration
     - Hold duration
     - Fade duration
     - HTML5 mode toggle

2. **Manage Performance**
   - Control which frame is displayed
   - Start/stop voting periods
   - Pause and resume the performance
   - Navigate history
   - Monitor connected players

### Score File Format

Scores are organized in folders under `/public/data/`:
```
ScoreName/
  ├── frame1.svg
  ├── frame2.svg
  ├── ...
  └── Documentation/  (optional)
      └── info.svg

Or with audio:
ScoreName/
  ├── Frames/
  │   ├── frame1.svg
  │   ├── frame2.svg
  │   └── ...
  ├── Sounds/
  │   ├── sound1.mp3
  │   └── ...
  └── Documentation/  (optional)
      └── info.svg
```

SVG files contain embedded links (`<a>` tags with `href` attributes) pointing to other frame filenames, creating the navigation graph.

## Development Setup

### Prerequisites
- Node.js (v12 or higher)
- npm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/nestednotation/nestednotation.git
   cd nestednotation
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   Create `.env.development` and `.env.production` files:
   ```
   SERVER_IP=your-server-ip-or-domain
   ```

4. Set up admin account:
   Create `/account/admin.dat` file with admin credentials

5. Add musical scores:
   Place SVG score files in `/public/data/ScoreName/`

### Running the Application

Development mode:
```bash
npm start
```

The application will start on port 3000 (or as configured in `bin/www`).

## Project Structure

```
nestednotation/
├── app.js                 # Express application setup
├── database.js            # Data models and business logic
├── constants.js           # Message types and constants
├── routes/                # Request handlers
│   ├── index.js          # Landing page
│   ├── session.js        # Performance sessions
│   ├── admin.js          # Admin interface
│   ├── setup.js          # Session configuration
│   ├── sm.js             # Session management
│   └── finish.js         # Completion handling
├── views/                 # Jade templates
├── public/                # Static assets
│   ├── data/             # Musical score files
│   ├── javascripts/      # Client-side scripts
│   └── stylesheets/      # CSS files
├── middleware/            # Express middleware
├── utils/                 # Utility functions
└── server_state/          # Persisted session data
```

## License

MIT License - see [LICENSE](LICENSE) file for details

## Credits

Copyright (c) 2024 nestednotation
