import React from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import {App} from './App';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return{failed:true}}componentDidCatch(error:unknown){console.error('Chat UI error',error)}render(){return this.state.failed?<main className="error-screen"><h1>Something went wrong</h1><p>The chat is still connected. Please reopen this view.</p><button onClick={()=>this.setState({failed:false})}>Try again</button></main>:this.props.children}}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>);
